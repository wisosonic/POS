import { lbpToUsdCents, usdToLbp, type Currency } from './money';

// The payroll engine (docs/16 §5, P6b): a pure function from what an employee earned in a period to a payslip. No clock, no database, no floating
// point: money is whole minor units (LBP 1, USD cent), time is whole minutes, rates are integer basis points (10,000 = 100%). Intermediate products
// can pass 2^53, so they are done in BigInt and rounded ONCE, half away from zero. The rules (NSSF, tax) are DATA given to the function, never
// written into it: their rates change, and the accountant owns them.

export type PayType = 'monthly' | 'daily' | 'hourly';

export type PayProfile = {
  type: PayType;
  /** Per month, per day or per hour, by `type`, in `currency`'s minor unit. */
  baseMinor: number;
  currency: Currency;
  /** Minutes in one day after which the rest are overtime; null: no overtime. */
  overtimeAfterMinutes: number | null;
  /** Overtime multiplier in basis points: 15000 = 1.5 times. */
  overtimeBp: number;
  /** What a standard working day is, in minutes (the hourly value of a day's pay). */
  standardDayMinutes: number;
  /** Working days in a month (the hourly value of a month's pay). */
  workDaysPerMonth: number;
  /** A day counts as worked for a daily wage when it holds at least this many minutes. */
  dailyMinMinutes: number;
  /** The codes of the rules that apply to this person. */
  ruleCodes: string[];
};

export type PayRule = {
  code: string;
  name: string;
  /** `percent`: a rate of the base up to a cap. `brackets`: a progressive (marginal) scale. */
  kind: 'percent' | 'brackets';
  /** `employee`: taken from the pay. `employer`: a cost to the company, never taken from the pay. */
  side: 'employee' | 'employer';
  /** `gross`: the whole gross. `taxable`: the gross less the employee deductions that `reducesTax`. */
  base: 'gross' | 'taxable';
  /** An employee deduction that lowers the taxable amount (social security does). */
  reducesTax: boolean;
  /** The rule's own currency: the cap and the brackets are in it. A person paid in the other currency is converted at the run's rate. */
  currency: Currency;
  rateBp: number;
  /** `percent` only: the most of the base that counts (null: no cap). */
  capBaseMinor: number | null;
  /** `brackets` only: from this amount up, this rate, until the next bracket. */
  brackets: { fromMinor: number; rateBp: number }[];
};

export type Manual = { kind: 'earning' | 'deduction'; label: string; amountMinor: number };
export type LoanDue = { id: number; label: string; remainingMinor: number; installmentMinor: number };
export type PayLine = { code: string; label: string; amountMinor: number };

export type Slip = {
  currency: Currency;
  daysWorked: number;
  regularMinutes: number;
  overtimeMinutes: number;
  earnings: PayLine[];
  deductions: PayLine[];
  /** What the company pays on top (employer social security): not part of the net. */
  employerCosts: PayLine[];
  grossMinor: number;
  deductionsMinor: number;
  /** Always `grossMinor - deductionsMinor`. Can be negative only when manual deductions exceed the pay: the caller warns. */
  netMinor: number;
};

const TEN_THOUSAND = 10_000n;

/** Round-half-away-from-zero division of BigInts. */
function divRound(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError('divisor must be positive');
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = a / d;
  const q2 = (a - q * d) * 2n >= d ? q + 1n : q;
  return neg ? -q2 : q2;
}

function toNumber(n: bigint, what: string): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${what} is too large`);
  return Number(n);
}

function assertInt(v: number, what: string, min = 0): void {
  if (!Number.isSafeInteger(v) || v < min) throw new RangeError(`${what} must be a whole number of at least ${min}, got ${v}`);
}

/** Convert an amount between the pay currency and a rule's currency (a no-op when they are the same). */
function convert(amount: number, from: Currency, to: Currency, rate: number): number {
  if (from === to) return amount;
  return from === 'USD' ? usdToLbp(amount, rate) : lbpToUsdCents(amount, rate);
}

/** A percent rule: `rateBp` of the base, the base capped at `capBaseMinor`. */
function percent(base: number, rule: PayRule): number {
  const counted = rule.capBaseMinor === null ? base : Math.min(base, rule.capBaseMinor);
  return toNumber(divRound(BigInt(Math.max(0, counted)) * BigInt(rule.rateBp), TEN_THOUSAND), rule.code);
}

/** A progressive scale: each bracket's rate applies only to the part of the base inside it. One rounding for the whole scale. */
function brackets(base: number, rule: PayRule): number {
  const sorted = [...rule.brackets].sort((a, b) => a.fromMinor - b.fromMinor);
  let sum = 0n;
  sorted.forEach((b, i) => {
    const upper = i + 1 < sorted.length ? Math.min(base, sorted[i + 1]!.fromMinor) : base;
    const inside = Math.max(0, upper - b.fromMinor);
    sum += BigInt(inside) * BigInt(b.rateBp);
  });
  return toNumber(divRound(sum, TEN_THOUSAND), rule.code);
}

function ruleAmount(rule: PayRule, baseInPay: number, payCurrency: Currency, rate: number): number {
  const base = convert(baseInPay, payCurrency, rule.currency, rate);
  const amount = rule.kind === 'percent' ? percent(base, rule) : brackets(base, rule);
  return convert(amount, rule.currency, payCurrency, rate);
}

/**
 * One employee's payslip for a period.
 * - Base pay: a month's salary as it stands, a day's rate for each worked day, or the hourly rate for the regular minutes.
 * - Overtime: the minutes of each day past `overtimeAfterMinutes`, at the hourly value of the pay times the multiplier.
 * - Manual lines (bonuses, deductions) are added as given.
 * - Rules in the profile's list: those on the gross (social security) first, then those on the taxable amount (income tax).
 * - Loan installments last, never more than what is owed nor more than the pay that is left.
 * Absence is not deducted here (that needs the roster, 6a-2): HR enters it as a manual deduction.
 */
export function calculatePayslip(input: {
  profile: PayProfile;
  days: { day: string; minutes: number }[];
  rules: PayRule[];
  rate: number;
  manual?: Manual[];
  loans?: LoanDue[];
}): Slip {
  const { profile: p, days, rate } = input;
  assertInt(p.baseMinor, 'The base pay');
  assertInt(p.overtimeBp, 'The overtime multiplier');
  assertInt(p.standardDayMinutes, 'The standard day', 1);
  assertInt(p.workDaysPerMonth, 'The working days in a month', 1);
  assertInt(p.dailyMinMinutes, 'The minimum minutes of a worked day');
  if (p.overtimeAfterMinutes !== null) assertInt(p.overtimeAfterMinutes, 'The overtime threshold');

  let regularMinutes = 0;
  let overtimeMinutes = 0;
  let daysWorked = 0;
  for (const d of days) {
    assertInt(d.minutes, 'Worked minutes');
    const after = p.overtimeAfterMinutes;
    regularMinutes += after === null ? d.minutes : Math.min(d.minutes, after);
    overtimeMinutes += after === null ? 0 : Math.max(0, d.minutes - after);
    if (d.minutes > 0 && d.minutes >= p.dailyMinMinutes) daysWorked += 1;
  }

  const earnings: PayLine[] = [];
  const base = BigInt(p.baseMinor);
  const baseAmount =
    p.type === 'monthly'
      ? p.baseMinor
      : p.type === 'daily'
        ? p.baseMinor * daysWorked
        : toNumber(divRound(base * BigInt(regularMinutes), 60n), 'base pay');
  earnings.push({
    code: 'base',
    label: p.type === 'monthly' ? 'Monthly salary' : p.type === 'daily' ? 'Days worked' : 'Hours worked',
    amountMinor: baseAmount,
  });

  if (overtimeMinutes > 0 && p.overtimeBp > 0) {
    const denominator =
      p.type === 'hourly'
        ? 60n * TEN_THOUSAND
        : p.type === 'daily'
          ? BigInt(p.standardDayMinutes) * TEN_THOUSAND
          : BigInt(p.workDaysPerMonth) * BigInt(p.standardDayMinutes) * TEN_THOUSAND;
    const pay = toNumber(divRound(base * BigInt(overtimeMinutes) * BigInt(p.overtimeBp), denominator), 'overtime');
    earnings.push({ code: 'overtime', label: 'Overtime', amountMinor: pay });
  }
  for (const m of input.manual ?? []) {
    assertInt(m.amountMinor, `The amount of "${m.label}"`, 1);
    if (m.kind === 'earning') earnings.push({ code: 'manual', label: m.label, amountMinor: m.amountMinor });
  }
  const grossMinor = earnings.reduce((s, e) => s + e.amountMinor, 0);

  // The rules, in the profile's list: on the gross first, then on the taxable amount.
  const chosen = input.rules.filter((r) => p.ruleCodes.includes(r.code));
  const deductions: PayLine[] = [];
  const employerCosts: PayLine[] = [];
  let taxReducing = 0;
  for (const rule of chosen.filter((r) => r.side === 'employee' && r.base === 'gross')) {
    const amount = ruleAmount(rule, grossMinor, p.currency, rate);
    if (amount > 0) deductions.push({ code: rule.code, label: rule.name, amountMinor: amount });
    if (rule.reducesTax) taxReducing += amount;
  }
  const taxable = Math.max(0, grossMinor - taxReducing);
  for (const rule of chosen.filter((r) => r.side === 'employee' && r.base === 'taxable')) {
    const amount = ruleAmount(rule, taxable, p.currency, rate);
    if (amount > 0) deductions.push({ code: rule.code, label: rule.name, amountMinor: amount });
  }
  for (const rule of chosen.filter((r) => r.side === 'employer')) {
    const amount = ruleAmount(rule, grossMinor, p.currency, rate);
    if (amount > 0) employerCosts.push({ code: rule.code, label: rule.name, amountMinor: amount });
  }
  for (const m of input.manual ?? [])
    if (m.kind === 'deduction') deductions.push({ code: 'manual', label: m.label, amountMinor: m.amountMinor });

  // Loans last: never more than is owed, never more than the pay left after everything else.
  let left = grossMinor - deductions.reduce((s, d) => s + d.amountMinor, 0);
  for (const loan of input.loans ?? []) {
    const amount = Math.max(0, Math.min(loan.installmentMinor, loan.remainingMinor, left));
    if (amount > 0) {
      deductions.push({ code: `loan:${loan.id}`, label: loan.label, amountMinor: amount });
      left -= amount;
    }
  }

  const deductionsMinor = deductions.reduce((s, d) => s + d.amountMinor, 0);
  return {
    currency: p.currency,
    daysWorked,
    regularMinutes,
    overtimeMinutes,
    earnings,
    deductions,
    employerCosts,
    grossMinor,
    deductionsMinor,
    netMinor: grossMinor - deductionsMinor,
  };
}
