// Reading a CSV file (the product import). Shared so the till can check a file the same way the server will.

/**
 * Split CSV text into rows of cells. Quotes may hold commas and line breaks, a doubled quote is one quote, any of CRLF, LF or CR
 * ends a row, a leading byte-order mark is ignored, and lines with nothing in them are skipped. A quote left open is an error:
 * the rest of the file would otherwise be read as one giant cell.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false; // inside "…"
  let wasQuoted = false; // the current cell had quotes, so "" is a real empty cell
  const endCell = () => {
    row.push(cell);
    cell = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endCell();
    if (row.length > 1 || row[0] !== '' || wasQuoted) rows.push(row);
    row = [];
  };

  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
      wasQuoted = true;
    } else if (ch === ',') endCell();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      if (src[i + 1] === '\n') i++;
      endRow();
    } else cell += ch;
  }
  if (quoted) throw new RangeError('The file has a quote that is never closed');
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * A decimal amount as written in a file ("75000", "1.25") to whole minor units (LBP whole, USD cents), with no floating point
 * and no guessing: a thousands separator, a currency sign, a minus, an exponent or too many decimals is an error, not a rounding.
 */
export function parseDecimalMinor(text: string, decimals: 0 | 2): number {
  const t = text.trim();
  const pattern = decimals === 0 ? /^\d+$/ : /^\d+(\.\d{1,2})?$/;
  if (!pattern.test(t)) {
    throw new RangeError(
      decimals === 0
        ? `"${t}" is not a whole number of lira (no commas, signs or decimals)`
        : `"${t}" is not an amount in dollars such as 1.25`,
    );
  }
  const [whole = '0', fraction = ''] = t.split('.');
  const minor = Number(whole + fraction.padEnd(decimals, '0'));
  if (!Number.isSafeInteger(minor)) throw new RangeError(`"${t}" is too large`);
  return minor;
}
