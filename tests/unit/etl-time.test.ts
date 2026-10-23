import { describe, it, expect } from 'vitest';
import { localToUtc, toUtcIso } from '../../apps/api/src/etl/time';

// Legacy timestamps are Beirut wall-clock text. These are checked against known facts about Lebanon's clock:
// UTC+2 in winter, UTC+3 in summer, with the change at midnight on the last Sunday of March and October.
describe('etl · legacy local time to UTC', () => {
  it('winter is UTC+2', () => {
    expect(localToUtc('2025-11-13 07:18:54.715')?.toISOString()).toBe('2025-11-13T05:18:54.715Z');
    expect(localToUtc('2026-01-15 12:00:00')?.toISOString()).toBe('2026-01-15T10:00:00.000Z');
  });

  it('summer is UTC+3', () => {
    expect(localToUtc('2026-07-01 12:00:00')?.toISOString()).toBe('2026-07-01T09:00:00.000Z');
    expect(localToUtc('2026-10-17 21:50:59.483')?.toISOString()).toBe('2026-10-17T18:50:59.483Z');
  });

  it('keeps milliseconds and drops digits beyond them (the register log has 7)', () => {
    expect(localToUtc('2026-01-01 19:53:15.3154028')?.toISOString()).toBe('2026-01-01T17:53:15.315Z');
    expect(localToUtc('2026-01-01 19:53:15.5')?.toISOString()).toBe('2026-01-01T17:53:15.500Z');
    expect(localToUtc('2026-01-01 19:53:15')?.toISOString()).toBe('2026-01-01T17:53:15.000Z');
  });

  it('accepts the ISO T separator', () => {
    expect(localToUtc('2026-02-28T00:00:00.0000000')?.toISOString()).toBe('2026-02-27T22:00:00.000Z');
  });

  it('local midnight is the previous evening in UTC', () => {
    expect(localToUtc('2026-01-15 00:00:00')?.toISOString()).toBe('2026-01-14T22:00:00.000Z');
  });

  it('a time that happened twice (the clock went back) is the first one', () => {
    // 2026-10-24 23:30 occurred in summer time (UTC+3) and again an hour later in winter time (UTC+2)
    const t = localToUtc('2026-10-24 23:30:00')!;
    expect(t.toISOString()).toBe('2026-10-24T20:30:00.000Z');
  });

  it('a time that never happened (the clock jumped forward) lands after the jump, not before', () => {
    const t = localToUtc('2026-03-29 00:30:00')!;
    const shown = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Beirut',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(t);
    expect(shown).toBe('01:30');
  });

  it('every converted time reads back as the same wall clock in Beirut (outside the two odd hours)', () => {
    const read = (d: Date) =>
      new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Beirut', hourCycle: 'h23', dateStyle: 'short', timeStyle: 'medium' })
        .format(d)
        .replace(' ', ' ');
    for (const s of ['2025-12-24 10:00:00', '2026-04-10 08:15:30', '2026-08-01 23:59:59', '2026-06-15 00:00:01']) {
      expect(read(localToUtc(s)!)).toBe(s);
    }
  });

  it('is null for anything that is not a timestamp', () => {
    // the last four look like timestamps but are impossible dates
    for (const bad of [
      '',
      '   ',
      'yesterday',
      '13/11/2025',
      null,
      undefined,
      '2025-13-45 10:00:00',
      '2026-02-30 10:00:00',
      '2026-01-01 25:00:00',
      '2026-01-01 10:61:00',
    ]) {
      expect(localToUtc(bad as string), String(bad)).toBeNull();
    }
  });

  it('toUtcIso uses the fallback when the text is unusable', () => {
    expect(toUtcIso('2026-01-15 12:00:00')).toBe('2026-01-15T10:00:00.000Z');
    expect(toUtcIso('junk', '2000-01-01T00:00:00.000Z')).toBe('2000-01-01T00:00:00.000Z');
    expect(toUtcIso('junk')).toBeNull();
  });
});
