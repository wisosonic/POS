import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { E } from '../errors';
import type { Db } from '../db/open';

/** JSON with sorted keys, so the same request always hashes the same however the client ordered its fields. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const hashRequest = (body: unknown): string => createHash('sha256').update(stable(body)).digest('hex');

/** The `Idempotency-Key` header is mandatory on money-moving POSTs (docs/06-api-spec.md). */
export function requireIdempotencyKey(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
    throw E.validation('An Idempotency-Key header (1 to 128 printable characters) is required');
  }
  return key;
}

export type StoredResponse = { statusCode: number; body: unknown };

/**
 * Look up a previous answer for this key. Same key and same request → that answer (replay).
 * Same key and a different request → 422 IDEMPOTENCY_CONFLICT. Must run inside the write transaction that would
 * otherwise create the record, so two parallel duplicates cannot both get past it.
 */
export function findReplay(db: Db, scope: string, key: string, requestHash: string): StoredResponse | null {
  const row = db
    .prepare('SELECT request_hash, status_code, response_json FROM idempotency_keys WHERE scope = ? AND key = ?')
    .get(scope, key) as { request_hash: string; status_code: number; response_json: string } | undefined;
  if (!row) return null;
  if (row.request_hash !== requestHash) {
    throw E.unprocessable('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used for a different request');
  }
  return { statusCode: row.status_code, body: JSON.parse(row.response_json) };
}

export function rememberResponse(db: Db, scope: string, key: string, requestHash: string, statusCode: number, body: unknown): void {
  db.prepare('INSERT INTO idempotency_keys (key, scope, request_hash, status_code, response_json) VALUES (?, ?, ?, ?, ?)').run(
    key,
    scope,
    requestHash,
    statusCode,
    JSON.stringify(body),
  );
}
