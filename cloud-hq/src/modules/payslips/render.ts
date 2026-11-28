// A payslip as a page the browser prints or saves as PDF (docs/16 §7). Server-rendered, no script, one inline style block: nothing here can run code.
// Every value from the database goes through `esc`. English or Arabic (right to left); amounts keep Western digits.

export type SlipView = {
  employeeName: string;
  employeeCode: string;
  fromDay: string;
  toDay: string;
  currency: 'LBP' | 'USD';
  daysWorked: number;
  regularMinutes: number;
  overtimeMinutes: number;
  grossMinor: number;
  deductionsMinor: number;
  netMinor: number;
  earnings: { label: string; amountMinor: number }[];
  deductions: { label: string; amountMinor: number }[];
};

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string | number): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]!);

const T = {
  en: {
    title: 'Payslip',
    employee: 'Employee',
    code: 'Code',
    period: 'Period',
    days: 'Days worked',
    hours: 'Hours worked',
    overtime: 'Overtime hours',
    earnings: 'Earnings',
    deductions: 'Deductions',
    none: 'None',
    gross: 'Gross pay',
    totalDeductions: 'Total deductions',
    net: 'Net pay',
    amount: 'Amount',
    description: 'Description',
    print: 'Print this page or save it as PDF from the browser.',
    lines: {} as Record<string, string>,
  },
  ar: {
    title: 'قسيمة الراتب',
    employee: 'الموظف',
    code: 'الرمز',
    period: 'الفترة',
    days: 'أيام العمل',
    hours: 'ساعات العمل',
    overtime: 'ساعات إضافية',
    earnings: 'المستحقات',
    deductions: 'الاستقطاعات',
    none: 'لا شيء',
    gross: 'الراتب الإجمالي',
    totalDeductions: 'مجموع الاستقطاعات',
    net: 'صافي الراتب',
    amount: 'المبلغ',
    description: 'البيان',
    print: 'اطبع هذه الصفحة أو احفظها بصيغة PDF من المتصفح.',
    // the lines the engine writes in English, shown in the reader's language (a rule's own name is shown as it was entered)
    lines: {
      'Monthly salary': 'الراتب الشهري',
      'Days worked': 'أيام العمل',
      'Hours worked': 'ساعات العمل',
      Overtime: 'العمل الإضافي',
    } as Record<string, string>,
  },
} as const;

/** Whole minor units as text: lira in whole pounds, dollars with cents. */
export function money(minor: number, currency: 'LBP' | 'USD'): string {
  if (currency === 'LBP') return `${minor.toLocaleString('en-US')} L.L.`;
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

const hm = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;

export function renderPayslip(s: SlipView, lang: 'en' | 'ar', generatedAt: string): string {
  const t = T[lang];
  const label = (l: string) => t.lines[l] ?? l;
  const rows = (list: { label: string; amountMinor: number }[]) =>
    list.length === 0
      ? `<tr><td colspan="2" class="muted">${esc(t.none)}</td></tr>`
      : list.map((l) => `<tr><td>${esc(label(l.label))}</td><td class="num">${esc(money(l.amountMinor, s.currency))}</td></tr>`).join('');
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(t.title)} - ${esc(s.employeeName)}</title>
<style>
body{font-family:system-ui,"Segoe UI",Tahoma,Arial,sans-serif;margin:0;padding:24px;color:#111;background:#fff}
main{max-width:720px;margin:0 auto}
h1{font-size:22px;margin:0 0 12px}
h2{font-size:16px;margin:20px 0 6px}
table{width:100%;border-collapse:collapse}
td,th{padding:6px 8px;border-bottom:1px solid #ddd;text-align:start}
.num{text-align:end;font-variant-numeric:tabular-nums;white-space:nowrap}
.muted{color:#666}
.total td{font-weight:700;border-top:2px solid #111}
.head td{border:0;padding:2px 8px}
.net td{font-size:18px;font-weight:700;border-top:3px double #111}
footer{margin-top:24px;font-size:12px;color:#666}
@media print{footer .noprint{display:none}}
</style>
</head>
<body>
<main>
<h1>${esc(t.title)}</h1>
<table class="head">
<tr><td>${esc(t.employee)}</td><td><strong>${esc(s.employeeName)}</strong></td></tr>
<tr><td>${esc(t.code)}</td><td>${esc(s.employeeCode)}</td></tr>
<tr><td>${esc(t.period)}</td><td>${esc(s.fromDay)} &ndash; ${esc(s.toDay)}</td></tr>
<tr><td>${esc(t.days)}</td><td>${esc(s.daysWorked)}</td></tr>
<tr><td>${esc(t.hours)}</td><td>${esc(hm(s.regularMinutes))}</td></tr>
<tr><td>${esc(t.overtime)}</td><td>${esc(hm(s.overtimeMinutes))}</td></tr>
</table>
<h2>${esc(t.earnings)}</h2>
<table><thead><tr><th>${esc(t.description)}</th><th class="num">${esc(t.amount)}</th></tr></thead><tbody>${rows(s.earnings)}
<tr class="total"><td>${esc(t.gross)}</td><td class="num">${esc(money(s.grossMinor, s.currency))}</td></tr></tbody></table>
<h2>${esc(t.deductions)}</h2>
<table><tbody>${rows(s.deductions)}
<tr class="total"><td>${esc(t.totalDeductions)}</td><td class="num">${esc(money(s.deductionsMinor, s.currency))}</td></tr></tbody></table>
<table style="margin-top:16px"><tbody><tr class="net"><td>${esc(t.net)}</td><td class="num">${esc(money(s.netMinor, s.currency))}</td></tr></tbody></table>
<footer><span class="noprint">${esc(t.print)}</span> ${esc(generatedAt.slice(0, 16).replace('T', ' '))} UTC</footer>
</main>
</body>
</html>
`;
}
