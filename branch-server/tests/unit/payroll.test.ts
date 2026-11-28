import { describe, expect, it } from 'vitest';
import { calculatePayslip, type PayProfile, type PayRule } from '@pos/shared';

// The payroll engine (docs/16 §5, P6b): golden cases worked out on paper. Every one also checks the invariant net = Σ earnings - Σ deductions.

const profile = (over: Partial<PayProfile> = {}): PayProfile => ({
  type: 'monthly',
  baseMinor: 0,
  currency: 'LBP',
  overtimeAfterMinutes: 480,
  overtimeBp: 15_000,
  standardDayMinutes: 480,
  workDaysPerMonth: 26,
  dailyMinMinutes: 240,
  ruleCodes: [],
  ...over,
});
const days = (...minutes: number[]) => minutes.map((m, i) => ({ day: `2026-11-${String(i + 1).padStart(2, '0')}`, minutes: m }));
const nssf: PayRule = {
  code: 'NSSF',
  name: 'Social security',
  kind: 'percent',
  side: 'employee',
  base: 'gross',
  reducesTax: true,
  currency: 'LBP',
  rateBp: 200,
  capBaseMinor: 18_000_000,
  brackets: [],
};
const nssfEmployer: PayRule = {
  ...nssf,
  code: 'NSSF_ER',
  name: 'Social security (employer)',
  side: 'employer',
  reducesTax: false,
  rateBp: 1_000,
};
const tax: PayRule = {
  code: 'TAX',
  name: 'Income tax',
  kind: 'brackets',
  side: 'employee',
  base: 'taxable',
  reducesTax: false,
  currency: 'LBP',
  rateBp: 0,
  capBaseMinor: null,
  brackets: [
    { fromMinor: 0, rateBp: 0 },
    { fromMinor: 5_000_000, rateBp: 500 },
    { fromMinor: 15_000_000, rateBp: 1_000 },
  ],
};
const RATE = 90_000;

function check(slip: ReturnType<typeof calculatePayslip>) {
  expect(slip.netMinor).toBe(slip.earnings.reduce((s, l) => s + l.amountMinor, 0) - slip.deductions.reduce((s, l) => s + l.amountMinor, 0));
  expect(slip.grossMinor).toBe(slip.earnings.reduce((s, l) => s + l.amountMinor, 0));
  expect(slip.deductionsMinor).toBe(slip.deductions.reduce((s, l) => s + l.amountMinor, 0));
  return slip;
}

describe('base pay and overtime (US-HR-payroll)', () => {
  it('hourly: the regular minutes at the hourly rate, the rest at time and a half', () => {
    // 600 + 480 + 300 minutes: regular 480 + 480 + 300 = 1,260 min = 21 h; overtime 120 min = 2 h
    const s = check(
      calculatePayslip({ profile: profile({ type: 'hourly', baseMinor: 100_000 }), days: days(600, 480, 300), rules: [], rate: RATE }),
    );
    expect(s.regularMinutes).toBe(1_260);
    expect(s.overtimeMinutes).toBe(120);
    expect(s.earnings.map((e) => [e.code, e.amountMinor])).toEqual([
      ['base', 2_100_000],
      ['overtime', 300_000],
    ]);
    expect(s.netMinor).toBe(2_400_000);
  });

  it('daily: each day of at least the minimum counts once; overtime is paid at the day rate over a standard day', () => {
    // days: 480 (worked), 540 (worked, 60 overtime), 0, 200 (under the 240 minimum: not a day)
    const s = check(
      calculatePayslip({ profile: profile({ type: 'daily', baseMinor: 1_500_000 }), days: days(480, 540, 0, 200), rules: [], rate: RATE }),
    );
    expect(s.daysWorked).toBe(2);
    expect(s.earnings.map((e) => [e.code, e.amountMinor])).toEqual([
      ['base', 3_000_000],
      ['overtime', 281_250],
    ]);
  });

  it('monthly: the salary as it stands, overtime at its hourly value (salary over working days over the standard day)', () => {
    const s = check(calculatePayslip({ profile: profile({ baseMinor: 26_000_000 }), days: days(600), rules: [], rate: RATE }));
    expect(s.earnings.map((e) => [e.code, e.amountMinor])).toEqual([
      ['base', 26_000_000],
      ['overtime', 375_000],
    ]);
  });

  it('no overtime threshold means no overtime, and a multiplier of zero pays none', () => {
    const none = check(
      calculatePayslip({
        profile: profile({ type: 'hourly', baseMinor: 60_000, overtimeAfterMinutes: null }),
        days: days(720),
        rules: [],
        rate: RATE,
      }),
    );
    expect(none.earnings).toHaveLength(1);
    expect(none.earnings[0]!.amountMinor).toBe(720_000);
    const zero = check(
      calculatePayslip({ profile: profile({ type: 'hourly', baseMinor: 60_000, overtimeBp: 0 }), days: days(720), rules: [], rate: RATE }),
    );
    expect(zero.earnings.map((e) => e.code)).toEqual(['base']);
  });

  it('rounds once, half up, in whole minor units', () => {
    // 33,333 an hour for 7 minutes = 3,888.85 -> 3,889
    const s = check(
      calculatePayslip({
        profile: profile({ type: 'hourly', baseMinor: 33_333, overtimeAfterMinutes: null }),
        days: days(7),
        rules: [],
        rate: RATE,
      }),
    );
    expect(s.earnings[0]!.amountMinor).toBe(3_889);
  });

  it('a month with no attendance: a daily or hourly wage earns nothing, a salary still stands', () => {
    expect(
      calculatePayslip({ profile: profile({ type: 'daily', baseMinor: 1_500_000 }), days: [], rules: [], rate: RATE }).grossMinor,
    ).toBe(0);
    expect(calculatePayslip({ profile: profile({ baseMinor: 5_000_000 }), days: [], rules: [], rate: RATE }).grossMinor).toBe(5_000_000);
  });
});

describe('rules from data (US-HR-payroll)', () => {
  it('social security is capped and lowers the taxable amount; tax is progressive; the employer cost is not deducted', () => {
    // 26,000,000 + 375,000 overtime = 26,375,000. NSSF 2% of the 18,000,000 cap = 360,000. Taxable 26,015,000:
    // 5% of 10,000,000 (5m to 15m) = 500,000 + 10% of 11,015,000 = 1,101,500 -> 1,601,500. Employer 10% of 18,000,000 = 1,800,000.
    const s = check(
      calculatePayslip({
        profile: profile({ baseMinor: 26_000_000, ruleCodes: ['NSSF', 'TAX', 'NSSF_ER'] }),
        days: days(600),
        rules: [tax, nssfEmployer, nssf], // the order given does not matter
        rate: RATE,
      }),
    );
    expect(s.deductions.map((d) => [d.code, d.amountMinor])).toEqual([
      ['NSSF', 360_000],
      ['TAX', 1_601_500],
    ]);
    expect(s.employerCosts.map((d) => [d.code, d.amountMinor])).toEqual([['NSSF_ER', 1_800_000]]);
    expect(s.netMinor).toBe(24_413_500);
  });

  it('only the rules in the profile apply (a person exempt from social security)', () => {
    const s = check(
      calculatePayslip({ profile: profile({ baseMinor: 1_000_000, ruleCodes: [] }), days: [], rules: [nssf, tax], rate: RATE }),
    );
    expect(s.deductions).toEqual([]);
    expect(s.netMinor).toBe(1_000_000);
  });

  it('under the first taxable bracket nothing is taken, and a rule that gives zero is not shown', () => {
    const s = check(
      calculatePayslip({ profile: profile({ baseMinor: 3_000_000, ruleCodes: ['TAX'] }), days: [], rules: [tax], rate: RATE }),
    );
    expect(s.deductions).toEqual([]);
  });

  it('a person paid in dollars: the rule is worked out in its own currency and brought back', () => {
    // $10 an hour for 8 hours = 8,000 cents. In lira at 90,000: 7,200,000. 2% = 144,000 LBP = 160 cents.
    const s = check(
      calculatePayslip({
        profile: profile({ type: 'hourly', currency: 'USD', baseMinor: 1_000, ruleCodes: ['NSSF'] }),
        days: days(480),
        rules: [nssf],
        rate: RATE,
      }),
    );
    expect(s.currency).toBe('USD');
    expect(s.grossMinor).toBe(8_000);
    expect(s.deductions.map((d) => [d.code, d.amountMinor])).toEqual([['NSSF', 160]]);
    expect(s.netMinor).toBe(7_840);
  });
});

describe('manual lines and loans (US-HR-payroll)', () => {
  it('a bonus raises the gross (and so the rules); a manual deduction lowers the net', () => {
    const s = check(
      calculatePayslip({
        profile: profile({ baseMinor: 1_000_000, ruleCodes: ['NSSF'] }),
        days: [],
        rules: [nssf],
        rate: RATE,
        manual: [
          { kind: 'earning', label: 'Eid bonus', amountMinor: 500_000 },
          { kind: 'deduction', label: 'Absent two days', amountMinor: 100_000 },
        ],
      }),
    );
    expect(s.grossMinor).toBe(1_500_000);
    expect(s.deductions.map((d) => [d.label, d.amountMinor])).toEqual([
      ['Social security', 30_000],
      ['Absent two days', 100_000],
    ]);
    expect(s.netMinor).toBe(1_370_000);
  });

  it('a loan installment is never more than what is owed, nor than the pay that is left', () => {
    const base = { profile: profile({ baseMinor: 1_000_000 }), days: [], rules: [], rate: RATE };
    // last installment: 300,000 asked, 200,000 left to pay
    expect(
      check(calculatePayslip({ ...base, loans: [{ id: 1, label: 'Advance', remainingMinor: 200_000, installmentMinor: 300_000 }] }))
        .deductions[0]!.amountMinor,
    ).toBe(200_000);
    // two loans: the second is limited by the pay left (1,000,000 - 700,000 = 300,000)
    const two = check(
      calculatePayslip({
        ...base,
        loans: [
          { id: 1, label: 'A', remainingMinor: 5_000_000, installmentMinor: 700_000 },
          { id: 2, label: 'B', remainingMinor: 5_000_000, installmentMinor: 500_000 },
        ],
      }),
    );
    expect(two.deductions.map((d) => [d.code, d.amountMinor])).toEqual([
      ['loan:1', 700_000],
      ['loan:2', 300_000],
    ]);
    expect(two.netMinor).toBe(0);
  });

  it('refuses nonsense: a fractional amount, a negative base, a zero standard day', () => {
    expect(() => calculatePayslip({ profile: profile({ baseMinor: 10.5 }), days: [], rules: [], rate: RATE })).toThrow(RangeError);
    expect(() => calculatePayslip({ profile: profile({ baseMinor: -1 }), days: [], rules: [], rate: RATE })).toThrow(RangeError);
    expect(() => calculatePayslip({ profile: profile({ standardDayMinutes: 0 }), days: [], rules: [], rate: RATE })).toThrow(RangeError);
    expect(() => calculatePayslip({ profile: profile(), days: [{ day: 'x', minutes: 1.5 }], rules: [], rate: RATE })).toThrow(RangeError);
  });

  it('big amounts do not lose a unit to floating point (an hourly rate in the millions for a long month)', () => {
    // 4,000,000 an hour x 240 hours of overtime at 1.5 = 1,440,000,000 exactly; the product 4e6 x 14,400 x 15,000 passes 2^53 in a plain number
    const s = check(
      calculatePayslip({
        profile: profile({ type: 'hourly', baseMinor: 4_000_000, overtimeAfterMinutes: 0 }),
        days: days(14_400),
        rules: [],
        rate: RATE,
      }),
    );
    expect(s.earnings.find((e) => e.code === 'overtime')!.amountMinor).toBe(1_440_000_000);
  });
});
