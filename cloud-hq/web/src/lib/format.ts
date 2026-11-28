// Small pure helpers for showing figures. Money is whole lira (LBP) or cents (USD): never floating point.

/** 1234567 -> "1,234,567 L.L." */
export const lbp = (n: number): string => `${n.toLocaleString('en-US')} L.L.`;

/** Cents as dollars: 123456 -> "$1,234.56". */
export function usd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/** How long ago, in words a shop owner uses. `now` is passed in so the answer is testable. */
export function ago(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes)) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** The plain-English line for each problem code HQ's monitoring can report. */
const PROBLEMS: Record<string, string> = {
  NEVER_CONNECTED: 'Not connected yet. Finish the setup at the branch with its one-time code.',
  SILENT: 'HQ has not heard from it lately. Is the branch PC on and online? Its tills keep selling.',
  NOT_PULLING: 'It is not collecting HQ’s changes. Restart the branch server.',
  MISMATCH: 'On some day the branch and HQ hold different figures. Ask the branch to send everything again.',
  BACKUP_NOT_CONFIGURED: 'HQ is not set up to make backups. Set BACKUP_DIR.',
  BACKUP_STALE: 'HQ’s last backup is more than a day and a half old.',
  BACKUP_FAILED: 'HQ’s last backup failed. See the Backups page.',
};
export const problemText = (code: string): string => PROBLEMS[code] ?? code;

export const ROLES: { value: string; label: string; note: string }[] = [
  { value: 'viewer', label: 'Viewer', note: 'Reads the chain’s figures' },
  { value: 'catalog', label: 'Catalog', note: 'Also changes products, prices and rates' },
  { value: 'hr', label: 'HR', note: 'Also employees, rosters and leave' },
  { value: 'payroll', label: 'Payroll', note: 'Also pay and payslips' },
  { value: 'admin', label: 'Admin', note: 'Everything, including branches, people and backups' },
];

/** Money in its own currency: LBP in whole lira, USD in cents. */
export const money = (minor: number, currency: string): string => (currency === 'USD' ? usd(minor) : lbp(minor));

/** Worked minutes as hours and minutes: 485 -> "8 h 05". */
export function hm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

const FLAGS: Record<string, string> = {
  double_in: 'Clocked in twice',
  out_without_in: 'Clocked out without clocking in',
  open: 'Still clocked in',
};
export const flagText = (code: string): string => FLAGS[code] ?? code;

/** The punch time as a person reads it (the browser's own zone). */
export const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

/** A whole number typed as money ("1,500.50" for USD, "150000" for LBP) to minor units, exactly: no floats. null when it is not a clean amount. */
export function parseMinor(text: string, currency: string): number | null {
  const t = text.trim().replace(/,/g, '');
  const re = currency === 'USD' ? /^(\d{1,12})(?:\.(\d{1,2}))?$/ : /^(\d{1,12})$/;
  const m = re.exec(t);
  if (!m) return null;
  return currency === 'USD' ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0') : Number(m[1]);
}

/** A percentage typed by a person ("7.5") to basis points (750), exactly. null when it is not a clean percentage with at most two decimals. */
export function parseBp(text: string, max = 10_000): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim().replace('%', ''));
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return bp <= max ? bp : null;
}

/** Basis points as a percentage: 750 -> "7.5%", 2000 -> "20%". */
export const bpText = (bp: number): string => `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

export const RUN_STEPS = ['draft', 'calculated', 'approved', 'paid', 'locked'] as const;
export const RUN_WORDS: Record<string, string> = {
  draft: 'Draft: add any extra lines, then calculate',
  calculated: 'Calculated: check the payslips, then approve',
  approved: 'Approved: the figures are frozen. Pay, then lock',
  paid: 'Paid: lock it when the books agree',
  locked: 'Locked: final',
};

/** Minutes after midnight as a clock time: 510 -> "08:30". */
export const minuteText = (m: number): string => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** "8:30" or "08:30" as minutes (510). null when it is not a time of day. With `length`, "10:00" and up to "24:00" are allowed. */
export function parseTime(text: string, length = false): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  const total = h * 60 + min;
  return total <= (length ? 1440 : 1439) ? total : null;
}

/** A shift as people say it: "08:00 to 16:00", "22:00 to 06:00 (next day)". */
export function shiftText(startMinute: number, lengthMinutes: number): string {
  const end = startMinute + lengthMinutes;
  return `${minuteText(startMinute)} to ${minuteText(end)}${end >= 1440 ? ' (next day)' : ''}`;
}

/** A shop day moved by n days (days are plain dates, so this is exact: no time zone is involved). */
export const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The Monday of the week a day is in. */
export function weekStart(day: string): string {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

/** Mon, Tue ... for a day. */
export const weekdayName = (day: string): string =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

const SCHEDULE_STATUS: Record<string, string> = {
  worked: 'Worked',
  absent: 'Absent',
  on_leave: 'On leave',
  holiday: 'Holiday',
  unscheduled: 'Not on the roster',
  scheduled: 'Still to come',
};
export const scheduleStatusText = (s: string): string => SCHEDULE_STATUS[s] ?? s;

/** Thousandths as a quantity people read: 12500 -> "12.5", 3000 -> "3". */
export function qtyText(milli: number): string {
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  const frac = String(abs % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${sign}${Math.floor(abs / 1000).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

/** A typed quantity ("12", "2.5") as the text HQ expects, or null: a positive number with at most three decimals, nothing else. */
export function parseQty(text: string): string | null {
  const t = text.trim();
  return /^\d{1,9}(\.\d{1,3})?$/.test(t) && Number(t) > 0 ? t : null;
}

/** Thousandths as the text a quantity field takes, never in floating point: 12500 -> "12.5". */
export const milliToQty = (milli: number): string => qtyText(milli).replace(/,/g, '');

/** Minor units as typed in a money field: 150050 USD -> "1500.50", 90000 LBP -> "90000". */
export function minorText(minor: number, currency: string): string {
  return currency === 'USD' ? `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}` : String(minor);
}

const ORDER_WORDS: Record<string, string> = {
  draft: 'Draft: nothing is ordered yet',
  ordered: 'Ordered: the stock branches expect these goods',
  closed: 'Closed: what arrived is accepted',
  cancelled: 'Cancelled',
};
export const orderStatusText = (s: string): string => ORDER_WORDS[s] ?? s;
