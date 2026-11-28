import { describe, expect, it } from 'vitest';
import { ago, lbp, problemText, usd } from '../../web/src/lib/format';

// The little helpers the HQ screen shows figures with (docs/18): money is whole units, "how long ago" is plain words, every problem code HQ reports has a sentence.
describe('the HQ screen helpers (US-HQ-screen)', () => {
  it('shows lira and dollars without floating point', () => {
    expect(lbp(1234567)).toBe('1,234,567 L.L.');
    expect(lbp(0)).toBe('0 L.L.');
    expect(usd(123456)).toBe('$1,234.56');
    expect(usd(5)).toBe('$0.05');
    expect(usd(-250)).toBe('-$2.50');
  });

  it('says how long ago in plain words', () => {
    const now = Date.parse('2026-11-28T12:00:00Z');
    expect(ago(null, now)).toBe('never');
    expect(ago('2026-11-28T11:59:40Z', now)).toBe('just now');
    expect(ago('2026-11-28T11:15:00Z', now)).toBe('45 min ago');
    expect(ago('2026-11-28T07:00:00Z', now)).toBe('5 h ago');
    expect(ago('2026-11-20T12:00:00Z', now)).toBe('8 days ago');
    expect(ago('not a date', now)).toBe('never');
  });

  it('has a sentence for every problem HQ can report, and shows an unknown code as it is', () => {
    for (const code of ['NEVER_CONNECTED', 'SILENT', 'NOT_PULLING', 'MISMATCH', 'BACKUP_NOT_CONFIGURED', 'BACKUP_STALE', 'BACKUP_FAILED'])
      expect(problemText(code)).not.toBe(code);
    expect(problemText('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
