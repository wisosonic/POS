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
