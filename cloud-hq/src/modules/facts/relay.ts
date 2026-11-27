import type { Queryable } from '@pos/core/adapter';
import { writeAudit } from '../staff/context';

// Relaying a shipment to the branch that must receive it (docs/15 §4, P5b). A shipment is written by the SENDING branch and arrives here as a fact
// (shipments + shipment_items). HQ turns it into `incoming_shipments` + items, which go DOWN to the receiving branch ONLY (the change log lines carry
// that branch's id), so the receiver sees "stock on the way" and confirms it with a receipt it writes itself. One writer per document: HQ never edits
// either side's row.
//
// A shipment is relayed once ALL its lines are here (the header says how many there are: a batch can end between the header and its lines). A
// shipment whose destination is not a branch HQ can deliver to (unknown, switched off, or the sender itself) is still recorded, so it is not
// tried again and shows in the transfers report as undeliverable, but nothing is sent to anyone (and it is audited once).

const nowIso = () => new Date().toISOString();

type Ready = { id: number; to_branch_id: number; reason: string; note: string | null; created_at: string };

/** Relay the shipments of one sending branch that are complete and not yet relayed. Call inside the transaction that stored its facts. */
export async function relayShipments(q: Queryable, fromBranchId: number): Promise<number> {
  const ready = await q.all<Ready>(
    `SELECT s.id, s.to_branch_id, s.reason, s.note, s.created_at FROM shipments s
     WHERE s.branch_id = ?
       AND NOT EXISTS (SELECT 1 FROM incoming_shipments i WHERE i.from_branch_id = s.branch_id AND i.shipment_id = s.id)
       AND (SELECT COUNT(*) FROM shipment_items x WHERE x.branch_id = s.branch_id AND x.shipment_id = s.id) >= s.item_count
     ORDER BY s.id`,
    [fromBranchId],
  );
  for (const s of ready) {
    const to = await q.one<{ id: number; active: number }>('SELECT id, active FROM branch_directory WHERE id = ?', [s.to_branch_id]);
    const deliverable = !!to && to.active === 1 && to.id !== fromBranchId;
    const now = nowIso();
    const incoming = (await q.one<{ id: number }>(
      `INSERT INTO incoming_shipments (from_branch_id, to_branch_id, shipment_id, reason, note, shipped_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [fromBranchId, s.to_branch_id, s.id, s.reason, s.note, s.created_at, now],
    ))!;
    await q.run(
      `INSERT INTO incoming_shipment_items (incoming_id, product_id, qty_milli, unit_cost)
       SELECT ?, x.product_id, x.qty_milli, x.unit_cost FROM shipment_items x WHERE x.branch_id = ? AND x.shipment_id = ? ORDER BY x.id`,
      [incoming.id, fromBranchId, s.id],
    );
    if (!deliverable) {
      await writeAudit(q, 'shipment.undeliverable', 'branch', fromBranchId, { shipmentId: s.id, toBranchId: s.to_branch_id });
      continue;
    }
    // The header first, then its lines: a branch applies a page in order.
    await q.run('INSERT INTO change_log (tbl, pk, op, created_at, branch_id) VALUES (?, ?, ?, ?, ?)', [
      'incoming_shipments',
      incoming.id,
      'u',
      now,
      s.to_branch_id,
    ]);
    for (const item of await q.all<{ id: number }>('SELECT id FROM incoming_shipment_items WHERE incoming_id = ? ORDER BY id', [
      incoming.id,
    ]))
      await q.run('INSERT INTO change_log (tbl, pk, op, created_at, branch_id) VALUES (?, ?, ?, ?, ?)', [
        'incoming_shipment_items',
        item.id,
        'u',
        now,
        s.to_branch_id,
      ]);
  }
  return ready.length;
}
