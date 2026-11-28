import { describe, expect, it } from 'vitest';
import { ago, bpText, flagText, hm, money, parseBp, parseMinor, problemText, usd, lbp } from '../../web/src/lib/format';

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

// The HR and payroll pages (docs/18): amounts are typed as text and must reach HQ as exact integers.
describe('the HR and payroll helpers (US-HQ-screen)', () => {
  it('turns typed amounts into minor units without floating point, and refuses the rest', () => {
    expect(parseMinor('150000', 'LBP')).toBe(150000);
    expect(parseMinor('1,500,000', 'LBP')).toBe(1500000);
    expect(parseMinor('1.5', 'LBP')).toBeNull();
    expect(parseMinor('1500.5', 'USD')).toBe(150050);
    expect(parseMinor('0.07', 'USD')).toBe(7);
    expect(parseMinor('12', 'USD')).toBe(1200);
    for (const bad of ['', 'abc', '-5', '1.234', '1e3', '1.', '.5']) expect(parseMinor(bad, 'USD')).toBeNull();
  });

  it('turns a typed percentage into basis points, within a limit', () => {
    expect(parseBp('7.5')).toBe(750);
    expect(parseBp('23%')).toBe(2300);
    expect(parseBp('100')).toBe(10000);
    expect(parseBp('100.01')).toBeNull();
    expect(parseBp('150')).toBeNull();
    expect(parseBp('150', 100_000)).toBe(15000);
    expect(parseBp('x')).toBeNull();
    expect(bpText(750)).toBe('7.5%');
    expect(bpText(2000)).toBe('20%');
    expect(bpText(15000)).toBe('150%');
  });

  it('shows money in its own currency, worked time as hours, and a sentence for each attendance flag', () => {
    expect(money(150050, 'USD')).toBe('$1,500.50');
    expect(money(900000, 'LBP')).toBe('900,000 L.L.');
    expect(hm(485)).toBe('8 h 05');
    expect(hm(0)).toBe('0 h 00');
    for (const f of ['double_in', 'out_without_in', 'open']) expect(flagText(f)).not.toBe(f);
    expect(flagText('NEW_ONE')).toBe('NEW_ONE');
  });
});
