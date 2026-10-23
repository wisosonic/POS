export type Cell = string | number | null | undefined;

const quote = (cell: Cell): string => {
  const text = cell === null || cell === undefined ? '' : String(cell);
  // A cell that begins with = + - @ can be run as a formula when the file is opened in a spreadsheet, so it is made plain text.
  // Real numbers are exempt: a negative amount is not an attack.
  const safe = typeof cell === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** Rows as CSV text: commas between cells, quotes doubled, CRLF between lines (what spreadsheets expect). */
export const toCsv = (rows: Cell[][]): string => rows.map((r) => r.map(quote).join(',')).join('\r\n');

/** Offer the rows as a file download. A leading byte-order mark makes Excel read Arabic names correctly. */
export function downloadCsv(filename: string, rows: Cell[][]): void {
  const blob = new Blob(['﻿', toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
