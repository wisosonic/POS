import { describe, it, expect } from 'vitest';
import { renderReceiptText, buildEscPos, type Receipt } from '@pos/shared/receipt';

const receipt: Receipt = {
  storeName: 'Darwish Market',
  address: 'lebanon , Beirut',
  phone: '71479893',
  ref: 24087,
  createdAt: '2026-10-19T10:42:00Z',
  cashier: 'Sara',
  register: 3,
  items: [
    { name: 'Cedars silver towel', qty: '1', unitPriceLbp: 75000, totalLbp: 75000 },
    { name: 'Crispy chocolate', qty: '2', unitPriceLbp: 50000, totalLbp: 100000 },
    { name: 'Uno laban 1kg', qty: '1', unitPriceLbp: 160000, totalLbp: 160000 },
  ],
  subtotalLbp: 335000,
  discountLbp: 0,
  totalLbp: 335000,
  rateLbpPerUsd: 90000,
  payments: [{ label: 'Cash LBP', amountLbp: 400000 }],
  changeLbp: 65000,
  footer: 'Thank you!',
};

describe('receipt · text rendering (US-06)', () => {
  const lines = renderReceiptText(receipt, { width: 42 }).split('\n');

  it('never exceeds the printer width', () => {
    expect(lines.every((l) => [...l].length <= 42)).toBe(true);
  });

  it('shows store header, receipt number and cashier', () => {
    const text = lines.join('\n');
    expect(text).toContain('DARWISH MARKET');
    expect(text).toContain('24087');
    expect(text).toContain('Sara');
  });

  it('formats money with thousands separators, right aligned', () => {
    const total = lines.find((l) => l.startsWith('TOTAL'))!;
    expect(total).toMatch(/335,000$/);
    expect([...total].length).toBe(42);
  });

  it('shows the USD equivalent with the rate', () => {
    const text = lines.join('\n');
    expect(text).toContain('3.72');
    expect(text).toContain('90,000');
  });

  it('shows tendered amount and change', () => {
    const text = lines.join('\n');
    expect(text).toMatch(/400,000/);
    expect(text).toMatch(/Change\s+65,000/);
  });

  it('wraps long product names instead of truncating them', () => {
    const long = {
      ...receipt,
      items: [{ name: 'Al Taghziah Hotdog 11pcs extra long product name here', qty: '1', unitPriceLbp: 200000, totalLbp: 200000 }],
    };
    const out = renderReceiptText(long, { width: 42 }).split('\n');
    expect(out.every((l) => [...l].length <= 42)).toBe(true);
    expect(out.join(' ')).toContain('name here');
  });

  it('shows the rounding adjustment only when the total was rounded', () => {
    const rounded = renderReceiptText({ ...receipt, subtotalLbp: 331000 }, { width: 42 });
    expect(rounded).toMatch(/Rounding\s+\+4,000/);
    expect(lines.join('\n')).not.toMatch(/Rounding/);
  });

  it('has no trailing spaces on any line', () => {
    const withCustomer = renderReceiptText({ ...receipt, customer: { name: 'ahmad darwish', balanceLbp: 0 } }, { width: 42 });
    expect(withCustomer.split('\n').every((l) => l === l.trimEnd())).toBe(true);
  });

  it('omits the discount row when there is no discount', () => {
    expect(lines.join('\n')).not.toMatch(/Discount/);
  });
});

describe('receipt · ESC/POS bytes', () => {
  it('starts with initialize (ESC @) and ends with a cut (GS V)', () => {
    const bytes = buildEscPos(receipt, { width: 42 });
    expect([bytes[0], bytes[1]]).toEqual([0x1b, 0x40]);
    const tail = Array.from(bytes.slice(-4));
    expect(tail).toContain(0x1d);
    expect(tail).toContain(0x56);
  });

  it('adds the cash-drawer pulse (ESC p) only when requested', () => {
    const has = (b: Uint8Array) => b.some((v, i) => v === 0x1b && b[i + 1] === 0x70);
    expect(has(buildEscPos(receipt, { width: 42, openDrawer: true }))).toBe(true);
    expect(has(buildEscPos(receipt, { width: 42 }))).toBe(false);
  });

  it('is English/ASCII only (printer has no Arabic code page): Arabic is transliterated, not printed as "?"', () => {
    const ar = { ...receipt, footer: 'شكراً', items: [{ name: 'خبز كبير', qty: '1', unitPriceLbp: 10000, totalLbp: 10000 }] };
    const bytes = Array.from(buildEscPos(ar, { width: 42 }));
    expect(bytes.every((b) => b < 0x80)).toBe(true);
    expect(bytes).not.toContain(0x3f); // no "?" because everything was transliterable
  });

  it('truly unprintable characters (e.g. emoji) become "?"', () => {
    const odd = { ...receipt, footer: 'Thanks 🙂' };
    const bytes = Array.from(buildEscPos(odd, { width: 42 }));
    expect(bytes.every((b) => b < 0x80)).toBe(true);
    expect(bytes).toContain(0x3f);
  });

  it('text rendering transliterates an Arabic name when no receiptName is set', () => {
    const r = { ...receipt, items: [{ name: 'خبز كبير', qty: '1', unitPriceLbp: 10000, totalLbp: 10000 }] };
    const text = renderReceiptText(r, { width: 42 });
    expect(text).not.toContain('خبز');
    expect(text).not.toContain('?');
  });

  it('text rendering prefers receiptName over name when present', () => {
    const r = { ...receipt, items: [{ name: 'خبز كبير', receiptName: 'Big bread', qty: '1', unitPriceLbp: 10000, totalLbp: 10000 }] };
    const text = renderReceiptText(r, { width: 42 });
    expect(text).toContain('Big bread');
    expect(text).not.toContain('خبز');
  });
});

describe('receipt · credit sales and payment methods (US-31, Q4/Q6)', () => {
  it('shows each payment method and the amount still owed by the customer', () => {
    const credit: Receipt = {
      ...receipt,
      customer: { name: 'ahmad darwish', balanceLbp: 135000 },
      payments: [
        { label: 'Whish', amountLbp: 50000 },
        { label: 'OMT', amountLbp: 50000 },
      ],
      paidLbp: 100000,
      changeLbp: 0,
      restLbp: 235000 - 100000,
      totalLbp: 235000,
      subtotalLbp: 235000,
    };
    const text = renderReceiptText(credit, { width: 42 });
    expect(text).toMatch(/Whish\s+50,000/);
    expect(text).toMatch(/OMT\s+50,000/);
    expect(text).toMatch(/Remaining\s+135,000/);
    expect(text).toContain('ahmad darwish');
    expect(text).toMatch(/Account balance\s+135,000/);
  });

  it('omits the Remaining row on fully paid sales', () => {
    expect(renderReceiptText(receipt, { width: 42 })).not.toMatch(/Remaining/);
  });
});

describe('receipt · a reprint says so (US-06)', () => {
  const copy = renderReceiptText({ ...receipt, duplicate: true }, { width: 42 }).split('\n');
  const original = renderReceiptText(receipt, { width: 42 }).split('\n');

  it('is marked DUPLICATE at the top, before the receipt number, and again at the bottom', () => {
    const marks = copy.map((l, i) => (l.includes('*** DUPLICATE ***') ? i : -1)).filter((i) => i >= 0);
    expect(marks).toHaveLength(2);
    expect(marks[0]).toBeLessThan(copy.findIndex((l) => l.includes('Receipt #24087')));
    expect(marks[1]).toBeGreaterThan(copy.findIndex((l) => l.includes('Change')));
  });

  it('the original has no such mark, and is otherwise the same receipt', () => {
    expect(original.some((l) => l.includes('DUPLICATE'))).toBe(false);
    const body = (lines: string[]) => lines.filter((l) => !/DUPLICATE|copy of the original/i.test(l) && !/^-+$/.test(l));
    expect(body(copy)).toEqual(body(original));
  });

  it('still fits the printer width and is plain ASCII, in any width', () => {
    for (const width of [32, 42, 48]) {
      const text = renderReceiptText({ ...receipt, duplicate: true }, { width });
      expect(
        text.split('\n').every((l) => [...l].length <= width),
        String(width),
      ).toBe(true);
      expect([...text].every((c) => c.charCodeAt(0) < 0x80)).toBe(true);
    }
  });

  it('is what the printer is sent, with the drawer left shut when asked', () => {
    const bytes = buildEscPos({ ...receipt, duplicate: true }, { width: 42, openDrawer: false });
    expect(Buffer.from(bytes).toString('latin1')).toContain('*** DUPLICATE ***');
    expect(bytes.some((b, i) => b === 0x1b && bytes[i + 1] === 0x70)).toBe(false); // no drawer pulse
  });
});
