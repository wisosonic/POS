import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Reads the legacy SQL Server dump (T-SQL: `GO` batches, `N'...'` literals, a UTF-8 byte order mark).
// The file is ~157 MB, almost all of it the `Images` table, so it is streamed line by line and tables we do not
// need are skipped without being parsed. Never read the whole file into memory.

export type SqlValue = string | number | null;
export type LegacyRow = Record<string, SqlValue>;
export type LegacyBatch = { table: string; columns: string[]; rows: LegacyRow[] };

const INSERT_HEADER = /^INSERT INTO \[dbo\]\.\[(\w+)\] \((.+)\) VALUES\s*$/;
const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;

/** Parse the rows of one INSERT statement body (everything after `VALUES`). */
export function parseRows(text: string, columns: string[]): LegacyRow[] {
  const rows: LegacyRow[] = [];
  let i = 0;
  const n = text.length;
  const skipSpace = () => {
    while (i < n && /\s/.test(text[i]!)) i++;
  };

  const readValue = (): SqlValue => {
    skipSpace();
    const c = text[i];
    if (c === "'" || ((c === 'N' || c === 'n') && text[i + 1] === "'")) {
      i += c === "'" ? 1 : 2;
      let out = '';
      for (;;) {
        const j = text.indexOf("'", i);
        if (j === -1) throw new Error('Unterminated string literal in the dump');
        out += text.slice(i, j);
        if (text[j + 1] === "'") {
          out += "'"; // '' is an escaped quote
          i = j + 2;
        } else {
          i = j + 1;
          return out;
        }
      }
    }
    if (text.startsWith('NULL', i) || text.startsWith('null', i)) {
      i += 4;
      return null;
    }
    if (text.startsWith('0x', i)) {
      const m = /^0x[0-9a-fA-F]*/.exec(text.slice(i, i + 64))!;
      // binary columns (images) are skipped before parsing; if one appears, consume it without keeping the bytes
      let j = i + 2;
      while (j < n && /[0-9a-fA-F]/.test(text[j]!)) j++;
      i = j;
      return `<binary ${m[0].length - 2}+ hex digits>`;
    }
    const m = NUMBER.exec(text.slice(i, i + 40));
    if (m) {
      i += m[0].length;
      return Number(m[0]);
    }
    throw new Error(`Unexpected token in the dump near: ${text.slice(i, i + 40)}`);
  };

  for (;;) {
    skipSpace();
    if (i >= n || text[i] === ';') break;
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text[i] !== '(') throw new Error(`Expected "(" near: ${text.slice(i, i + 40)}`);
    i++;
    const values: SqlValue[] = [];
    for (;;) {
      values.push(readValue());
      skipSpace();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === ')') {
        i++;
        break;
      }
      throw new Error(`Expected "," or ")" near: ${text.slice(i, i + 40)}`);
    }
    if (values.length !== columns.length) throw new Error(`A row has ${values.length} values for ${columns.length} columns`);
    const row: LegacyRow = {};
    columns.forEach((col, k) => {
      row[col] = values[k]!;
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Stream the dump and yield one batch per INSERT statement. Tables in `skip` are passed over without parsing.
 * A row may contain a line break inside a string, so a statement is only complete when a line ends outside a string.
 */
export async function* readLegacyDump(path: string, options: { skip?: ReadonlySet<string> } = {}): AsyncGenerator<LegacyBatch> {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  const skip = options.skip ?? new Set<string>();

  let table: string | null = null;
  let columns: string[] = [];
  let buffer: string[] = [];
  let inString = false;
  let skipping = false;
  let first = true;

  for await (let line of lines) {
    if (first) {
      line = line.replace(/^\uFEFF/, ''); // byte order mark
      first = false;
    }

    if (skipping) {
      if (line === 'GO') skipping = false;
      continue;
    }

    if (table === null) {
      const m = INSERT_HEADER.exec(line);
      if (!m) continue;
      if (skip.has(m[1]!)) {
        skipping = true;
        continue;
      }
      table = m[1]!;
      columns = m[2]!.split(',').map((c) => c.trim().replace(/^\[|\]$/g, ''));
      buffer = [];
      inString = false;
      continue;
    }

    buffer.push(line);
    for (let k = 0; k < line.length; k++) if (line.charCodeAt(k) === 39) inString = !inString; // a quote toggles; '' toggles twice
    if (!inString && line.endsWith(';')) {
      yield { table, columns, rows: parseRows(buffer.join('\n'), columns) };
      table = null;
      buffer = [];
    }
  }
  if (table !== null) throw new Error(`The dump ended in the middle of an INSERT into ${table}`);
}
