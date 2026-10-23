import { SHOP_TIME_ZONE } from '../util/time';

// The legacy app stored local shop time as text ("2025-11-13 07:18:54.715"), with no time zone. The new system stores UTC.

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/;

function offsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instantMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Convert a legacy local timestamp to the UTC instant it meant. Fractions of a second beyond milliseconds are dropped
 * (the legacy register log has 7 digits). Around a daylight-saving change:
 *  - a time that happened twice (the clock went back) resolves to the first occurrence;
 *  - a time that never happened (the clock jumped forward) resolves to the same wall-clock reading after the jump.
 * Returns null for text that is not a timestamp.
 */
export function localToUtc(local: string | null | undefined, timeZone: string = SHOP_TIME_ZONE): Date | null {
  const m = LOCAL.exec(String(local ?? '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  const ms = Number((m[7] ?? '').slice(0, 3).padEnd(3, '0'));
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  // Reject impossible dates ("2025-13-45", "2026-02-30", hour 25) instead of letting Date.UTC roll them into a real one.
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59)
    return null;

  // The offset can only be one of the two values in force a day before or after.
  const offsets = [...new Set([offsetMs(wall - 86_400_000, timeZone), offsetMs(wall + 86_400_000, timeZone)])];
  const valid = offsets.map((o) => wall - o).filter((t) => offsetMs(t, timeZone) === wall - t);
  if (valid.length > 0) return new Date(Math.min(...valid));
  return new Date(wall - Math.min(...offsets)); // inside the gap: land after the jump
}

export const toUtcIso = (local: string | null | undefined, fallback?: string | null): string | null =>
  localToUtc(local)?.toISOString() ?? fallback ?? null;
