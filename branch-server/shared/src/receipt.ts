// Receipt rendering for an 80 mm thermal printer (42 columns by default). ASCII only: the printer has no
// Arabic code page, so every string goes through transliterateArabic (Arabic → Latin, other → "?").
import { lbpToUsdCents } from './money';
import { toReceiptName, transliterateArabic } from './translit';

export type ReceiptItem = {
  name: string;
  receiptName?: string | null;
  qty: string;
  unitPriceLbp: number;
  totalLbp: number;
};

export type Receipt = {
  storeName: string;
  address?: string;
  phone?: string;
  ref: number;
  createdAt: string; // ISO-8601
  cashier: string;
  register?: number;
  customer?: { name: string; balanceLbp: number };
  items: ReceiptItem[];
  subtotalLbp: number;
  discountLbp?: number;
  totalLbp: number;
  rateLbpPerUsd: number;
  payments: { label: string; amountLbp: number }[];
  paidLbp?: number;
  changeLbp: number;
  restLbp?: number;
  footer?: string;
  /** A reprint of a receipt that was already given out. It says so at the top and the bottom, so it cannot pass for the original. */
  duplicate?: boolean;
  /** The sale was cancelled (voided). A reprint says so, so nobody takes it for a valid receipt. */
  voided?: boolean;
};

export type RenderOptions = {
  width?: number;
  /** IANA zone used to print the date. Defaults to the shop's. */
  timeZone?: string;
};

export type EscPosOptions = RenderOptions & {
  /** Pulse the cash drawer attached to the printer. */
  openDrawer?: boolean;
  /** Print the receipt number as a CODE39 barcode (so a return can scan it). Default true. */
  barcode?: boolean;
};

const DEFAULT_WIDTH = 42;
const DEFAULT_TZ = 'Asia/Beirut';

const ascii = (s: string) => transliterateArabic(s);
const len = (s: string) => [...s].length;

export function formatNumber(n: number): string {
  const sign = n < 0 ? '-' : '';
  return sign + String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** Word-wrap to `width`, breaking words longer than a line. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const rawWord of text.split(/\s+/).filter(Boolean)) {
    let word = rawWord;
    while (len(word) > width) {
      if (line) {
        out.push(line);
        line = '';
      }
      out.push([...word].slice(0, width).join(''));
      word = [...word].slice(width).join('');
    }
    if (!line) line = word;
    else if (len(line) + 1 + len(word) <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

export function renderReceiptText(r: Receipt, options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const tz = options.timeZone ?? DEFAULT_TZ;
  const out: string[] = [];

  const center = (text: string) => {
    for (const l of wrap(ascii(text), width)) out.push(' '.repeat(Math.floor((width - len(l)) / 2)) + l);
  };
  const row = (left: string, right: string) => {
    const l = ascii(left);
    const room = width - len(right) - 1;
    const fitted = len(l) > room ? [...l].slice(0, Math.max(room, 0)).join('') : l;
    out.push(right ? fitted + ' '.repeat(Math.max(width - len(fitted) - len(right), 1)) + right : fitted);
  };
  const sep = () => out.push('-'.repeat(width));

  center(r.storeName.toUpperCase());
  if (r.address) center(r.address);
  if (r.phone) center(`Tel ${r.phone}`);
  sep();
  if (r.voided) {
    center('*** VOIDED SALE ***');
    center('This sale was cancelled');
    sep();
  }
  if (r.duplicate) {
    center('*** DUPLICATE ***');
    center('A copy of the original receipt');
    sep();
  }
  row(`Receipt #${r.ref}`, formatDate(r.createdAt, tz));
  row(`Cashier: ${r.cashier}`, r.register !== undefined ? `Register: ${r.register}` : '');
  if (r.customer) row(`Customer: ${r.customer.name}`, '');
  sep();

  for (const item of r.items) {
    for (const l of wrap(toReceiptName(item), width)) out.push(l);
    row(`   ${Number(item.qty)} x ${formatNumber(item.unitPriceLbp)}`, formatNumber(item.totalLbp));
  }
  sep();

  row('Subtotal', formatNumber(r.subtotalLbp));
  if (r.discountLbp && r.discountLbp > 0) row('Discount', `-${formatNumber(r.discountLbp)}`);
  const rounding = r.totalLbp - (r.subtotalLbp - (r.discountLbp ?? 0));
  if (rounding !== 0) row('Rounding', `${rounding > 0 ? '+' : ''}${formatNumber(rounding)}`);
  row('TOTAL (LL)', formatNumber(r.totalLbp));
  const usd = (lbpToUsdCents(r.totalLbp, r.rateLbpPerUsd) / 100).toFixed(2);
  center(`USD ${usd} @ ${formatNumber(r.rateLbpPerUsd)}`);

  for (const p of r.payments) row(p.label, formatNumber(p.amountLbp));
  if (r.changeLbp > 0) row('Change', formatNumber(r.changeLbp));
  if (r.restLbp && r.restLbp > 0) row('Remaining', formatNumber(r.restLbp));
  if (r.customer) row('Account balance', formatNumber(r.customer.balanceLbp));
  sep();

  if (r.duplicate) center('*** DUPLICATE ***');
  if (r.voided) center('*** VOIDED SALE ***');
  if (r.footer) center(r.footer);
  return out.join('\n');
}

// ---------------------------------------------------------------- ESC/POS

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** Encode text as ASCII bytes. Anything non-ASCII that slipped through becomes "?". */
function encode(text: string): number[] {
  return [...text].map((c) => {
    const code = c.codePointAt(0) ?? 0x3f;
    return code < 0x80 ? code : 0x3f;
  });
}

export function buildEscPos(r: Receipt, options: EscPosOptions = {}): Uint8Array {
  const bytes: number[] = [ESC, 0x40]; // initialize
  bytes.push(ESC, 0x74, 0x00); // code page 0 (PC437): plain ASCII
  if (options.openDrawer) bytes.push(ESC, 0x70, 0x00, 25, 50); // pulse pin 2

  bytes.push(...encode(renderReceiptText(r, options)), LF);

  if (options.barcode !== false) {
    const data = encode(String(r.ref));
    bytes.push(ESC, 0x61, 0x01); // center
    bytes.push(GS, 0x68, 60); // height
    bytes.push(GS, 0x48, 0x02); // human-readable digits below
    bytes.push(GS, 0x6b, 0x04, ...data, 0x00); // CODE39
    bytes.push(ESC, 0x61, 0x00, LF); // left
  }

  bytes.push(LF, LF, LF);
  bytes.push(GS, 0x56, 0x42, 0x00); // partial cut with feed
  return Uint8Array.from(bytes);
}
