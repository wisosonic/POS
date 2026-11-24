import { describe, expect, it } from 'vitest';
import { parseCsv, parseDecimalMinor } from '@pos/shared';

// US-15 (product import): reading a spreadsheet's CSV without guessing.
describe('parseCsv', () => {
  it('reads plain rows with LF, CRLF or CR line ends, and ignores a trailing line end', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\r1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('ignores a leading byte-order mark (what Excel writes) so the first header is clean', () => {
    expect(parseCsv('﻿name,price\nx,1')[0]).toEqual(['name', 'price']);
  });

  it('reads quotes: commas, line breaks and doubled quotes inside a cell', () => {
    expect(parseCsv('"a,b","say ""hi""","line\nbreak"')).toEqual([['a,b', 'say "hi"', 'line\nbreak']]);
  });

  it('keeps empty cells, and skips lines that are empty altogether', () => {
    expect(parseCsv('a,,c\n\n,,\n"",x\n')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
      ['', 'x'],
    ]);
  });

  it('reads Arabic text as it is', () => {
    expect(parseCsv('اسم,سعر\nحليب,5000')[1]).toEqual(['حليب', '5000']);
  });

  it('refuses a quote that is never closed instead of swallowing the rest of the file', () => {
    expect(() => parseCsv('a,"b\nc,d')).toThrow(/never closed/);
  });

  it('an empty file has no rows', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });
});

describe('parseDecimalMinor', () => {
  it('reads lira as whole numbers and dollars as cents, exactly', () => {
    expect(parseDecimalMinor('75000', 0)).toBe(75000);
    expect(parseDecimalMinor(' 0 ', 0)).toBe(0);
    expect(parseDecimalMinor('1.25', 2)).toBe(125);
    expect(parseDecimalMinor('1.2', 2)).toBe(120);
    expect(parseDecimalMinor('3', 2)).toBe(300);
    expect(parseDecimalMinor('0.07', 2)).toBe(7);
    expect(parseDecimalMinor('19.99', 2)).toBe(1999); // 19.99 * 100 is 1998.9999999999998 as a float
  });

  it.each(['', 'abc', '-5', '+5', '1,000', '1e3', '$5', '75000.5', '5.', '.5', '1 000'])('refuses "%s" for lira', (text) => {
    expect(() => parseDecimalMinor(text, 0)).toThrow(RangeError);
  });

  it.each(['', '1.234', '1,25', '-1.00', '1e2', '$1.25', '.5'])('refuses "%s" for dollars', (text) => {
    expect(() => parseDecimalMinor(text, 2)).toThrow(RangeError);
  });

  it('refuses a number too big to hold exactly', () => {
    expect(() => parseDecimalMinor('9'.repeat(20), 0)).toThrow(/too large/);
  });
});
