import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRows, readLegacyDump, type LegacyBatch } from '../../apps/api/src/etl/parse';

// The legacy dump is T-SQL. These cases are the shapes found in the real file, plus the ones that would silently
// corrupt data if the parser guessed wrong (quotes inside names, line breaks inside text, NULL, negative numbers).
const dir = mkdtempSync(join(tmpdir(), 'pos-parse-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const dump = (name: string, text: string) => {
  const file = join(dir, name);
  writeFileSync(file, text, 'utf8');
  return file;
};
const read = async (file: string, skip: string[] = []) => {
  const out: LegacyBatch[] = [];
  for await (const b of readLegacyDump(file, { skip: new Set(skip) })) out.push(b);
  return out;
};

describe('etl · rows', () => {
  const cols = ['id', 'name', 'qty'];

  it('reads numbers, strings and NULL', () => {
    expect(parseRows("(1, N'Cedars', 2.5),\n(2, N'Uno', NULL);", cols)).toEqual([
      { id: 1, name: 'Cedars', qty: 2.5 },
      { id: 2, name: 'Uno', qty: null },
    ]);
  });

  it('reads negative numbers and exponents', () => {
    expect(parseRows("(-3, N'x', -0.608), (4, N'y', 1E3);", cols)).toEqual([
      { id: -3, name: 'x', qty: -0.608 },
      { id: 4, name: 'y', qty: 1000 },
    ]);
  });

  it("an escaped quote ('') is one quote, not the end of the string", () => {
    expect(parseRows("(1, N'O''Brien''s shop', 1);", cols)[0]!.name).toBe("O'Brien's shop");
    expect(parseRows("(1, N'''', 1);", cols)[0]!.name).toBe("'");
  });

  it('keeps commas, parentheses, semicolons and SQL keywords inside text as text', () => {
    const name = "a, b); INSERT INTO [dbo].[X] VALUES (1, 'z'); --";
    expect(parseRows(`(1, N'${name.replaceAll("'", "''")}', 7);`, cols)).toEqual([{ id: 1, name, qty: 7 }]);
  });

  it('keeps Arabic, accents and emoji exactly', () => {
    expect(parseRows("(1, N'خبز كبير café 🍵', 1);", cols)[0]!.name).toBe('خبز كبير café 🍵');
  });

  it('keeps a line break inside a string', () => {
    expect(parseRows("(1, N'line one\nline two', 1);", cols)[0]!.name).toBe('line one\nline two');
  });

  it('keeps an empty string and a string of spaces', () => {
    expect(parseRows("(1, N'', 1), (2, N'  ', 2);", cols).map((r) => r.name)).toEqual(['', '  ']);
  });

  it('reads a quoted (non-N) literal, which is how dates are written', () => {
    expect(parseRows("(1, '2026-02-28T00:00:00.0000000', 1);", cols)[0]!.name).toBe('2026-02-28T00:00:00.0000000');
  });

  it('reads JSON text with quotes, braces and brackets', () => {
    const json = '[{"id":1,"product":"Uno laban 1kg","qty":2}]';
    expect(parseRows(`(1, N'${json}', 1);`, cols)[0]!.name).toBe(json);
  });

  it('survives binary hex without keeping it', () => {
    expect(parseRows('(1, 0x89504E470D0A1A0A, 1);', cols)[0]!.id).toBe(1);
  });

  it('refuses a row with the wrong number of values rather than guessing', () => {
    expect(() => parseRows("(1, N'a');", cols)).toThrow(/2 values for 3 columns/);
  });

  it('refuses an unterminated string and unknown tokens', () => {
    expect(() => parseRows("(1, N'never closed, 1);", cols)).toThrow();
    expect(() => parseRows('(1, GETDATE(), 1);', cols)).toThrow(/Unexpected token/);
  });

  it('returns no rows for an empty statement', () => {
    expect(parseRows(';', cols)).toEqual([]);
  });
});

describe('etl · the dump file', () => {
  const header = (table: string, cols: string) => `INSERT INTO [dbo].[${table}] (${cols}) VALUES`;

  it('reads batches, ignores everything else, and strips the byte order mark', async () => {
    const file = dump(
      'a.sql',
      `\uFEFF-- Dump of database [POSDB]
SET NOCOUNT ON;
GO
CREATE TABLE [dbo].[Units] ([UnitID] int);
GO
SET IDENTITY_INSERT [dbo].[Units] ON;
GO
${header('Units', '[UnitID], [unitName]')}
(2, N'Piece '),
(3, N'KG');
GO
SET IDENTITY_INSERT [dbo].[Units] OFF;
GO
`,
    );
    expect(await read(file)).toEqual([
      {
        table: 'Units',
        columns: ['UnitID', 'unitName'],
        rows: [
          { UnitID: 2, unitName: 'Piece ' },
          { UnitID: 3, unitName: 'KG' },
        ],
      },
    ]);
  });

  it('reads several batches of the same table, in order', async () => {
    const file = dump('b.sql', `${header('T', '[a]')}\n(1),\n(2);\nGO\n${header('T', '[a]')}\n(3);\nGO\n`);
    const batches = await read(file);
    expect(batches.map((b) => b.rows.map((r) => r.a))).toEqual([[1, 2], [3]]);
  });

  it('a row with a line break inside a string does not end the statement early', async () => {
    const file = dump('c.sql', `${header('T', '[id], [note]')}\n(1, N'first;\nsecond'),\n(2, N'plain');\nGO\n`);
    const [batch] = await read(file);
    expect(batch!.rows).toEqual([
      { id: 1, note: 'first;\nsecond' },
      { id: 2, note: 'plain' },
    ]);
  });

  it('a string that ends a line with a semicolon is not mistaken for the end of the statement', async () => {
    const file = dump('d.sql', `${header('T', '[id], [note]')}\n(1, N'ends with a semicolon;'),\n(2, N'x');\nGO\n`);
    expect((await read(file))[0]!.rows).toHaveLength(2);
  });

  it('skips the tables it is told to without parsing them, even when they hold huge binary rows', async () => {
    const blob = `(1, 0x${'AB'.repeat(5000)}),\n(2, 0x${'CD'.repeat(5000)});`;
    const file = dump('e.sql', `${header('Images', '[Id], [Data]')}\n${blob}\nGO\n${header('Units', '[UnitID]')}\n(7);\nGO\n`);
    const batches = await read(file, ['Images']);
    expect(batches.map((b) => b.table)).toEqual(['Units']);
  });

  it('accepts Windows line endings', async () => {
    const file = dump('f.sql', `${header('T', '[a], [b]')}\r\n(1, N'x'),\r\n(2, N'y');\r\nGO\r\n`);
    expect((await read(file))[0]!.rows).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ]);
  });

  it('fails loudly when the file stops in the middle of an insert (a truncated dump)', async () => {
    const file = dump('g.sql', `${header('T', '[a]')}\n(1),\n(2),\n`);
    await expect(read(file)).rejects.toThrow(/middle of an INSERT into T/);
  });

  it('fails loudly on a row it cannot read instead of dropping it', async () => {
    const file = dump('h.sql', `${header('T', '[a], [b]')}\n(1, N'x'),\n(2, ???);\nGO\n`);
    await expect(read(file)).rejects.toThrow();
  });

  it('gives an empty result for a file with no inserts', async () => {
    expect(await read(dump('i.sql', 'SET NOCOUNT ON;\nGO\n'))).toEqual([]);
  });
});
