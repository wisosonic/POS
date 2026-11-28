import { describe, expect, it } from 'vitest';
import {
  addDays,
  ago,
  bpText,
  flagText,
  hm,
  lbp,
  milliToQty,
  minorText,
  minuteText,
  money,
  orderStatusText,
  parseBp,
  parseMinor,
  parseQty,
  parseTime,
  problemText,
  qtyText,
  scheduleStatusText,
  shiftText,
  usd,
  weekStart,
  weekdayName,
} from '../../web/src/lib/format';

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

// The schedule pages (docs/18): times are typed as text, weeks start on Monday, and every plan status HQ reports has a sentence.
describe('the schedule helpers (US-HQ-screen)', () => {
  it('reads and shows times of day', () => {
    expect(parseTime('08:30')).toBe(510);
    expect(parseTime('8:30')).toBe(510);
    expect(parseTime('23:59')).toBe(1439);
    for (const bad of ['', '24:00', '8', '08:60', '8:5', 'ab:cd', '-1:00']) expect(parseTime(bad)).toBeNull();
    expect(parseTime('24:00', true)).toBe(1440); // a length may be a whole day
    expect(parseTime('24:01', true)).toBeNull();
    expect(minuteText(510)).toBe('08:30');
    expect(minuteText(0)).toBe('00:00');
  });

  it('says a shift in words, including one that ends the next day', () => {
    expect(shiftText(480, 480)).toBe('08:00 to 16:00');
    expect(shiftText(1320, 480)).toBe('22:00 to 06:00 (next day)');
  });

  it('moves days exactly and finds the Monday of a week', () => {
    expect(addDays('2026-11-28', 3)).toBe('2026-12-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekStart('2026-11-28')).toBe('2026-11-23'); // a Saturday
    expect(weekStart('2026-11-23')).toBe('2026-11-23'); // a Monday
    expect(weekStart('2026-11-29')).toBe('2026-11-23'); // a Sunday belongs to the week before it
    expect(weekdayName('2026-11-23')).toBe('Mon');
  });

  it('has a sentence for every plan status, and shows an unknown one as it is', () => {
    for (const st of ['worked', 'absent', 'on_leave', 'holiday', 'unscheduled', 'scheduled']) expect(scheduleStatusText(st)).not.toBe(st);
    expect(scheduleStatusText('NEW')).toBe('NEW');
  });
});

// The purchasing pages (docs/18): quantities are thousandths, typed as text with at most three decimals and never through floating point.
describe('the purchasing helpers (US-HQ-screen)', () => {
  it('shows thousandths as a quantity and gives them back as typed text', () => {
    expect(qtyText(12500)).toBe('12.5');
    expect(qtyText(3000)).toBe('3');
    expect(qtyText(1)).toBe('0.001');
    expect(qtyText(1234567)).toBe('1,234.567');
    expect(qtyText(0)).toBe('0');
    expect(qtyText(-2500)).toBe('-2.5');
    expect(milliToQty(1234567)).toBe('1234.567');
    expect(milliToQty(20000)).toBe('20');
  });

  it('accepts a quantity only when it is a positive number with at most three decimals', () => {
    for (const ok of ['1', '12', '2.5', '0.001', '100000']) expect(parseQty(ok)).toBe(ok);
    for (const bad of ['', '0', '0.0', '-1', '1.2345', '1,5', '1e3', 'abc', '.5', '5.', '1 2']) expect(parseQty(bad)).toBeNull();
    expect(parseQty('  7 ')).toBe('7');
  });

  it('writes a cost the way it is typed in a money field', () => {
    expect(minorText(350, 'USD')).toBe('3.50');
    expect(minorText(5, 'USD')).toBe('0.05');
    expect(minorText(150050, 'USD')).toBe('1500.50');
    expect(minorText(90000, 'LBP')).toBe('90000');
  });

  it('has a sentence for every order state', () => {
    for (const st of ['draft', 'ordered', 'closed', 'cancelled']) expect(orderStatusText(st)).not.toBe(st);
    expect(orderStatusText('NEW')).toBe('NEW');
  });
});
