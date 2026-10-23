import { describe, expect, it } from 'vitest';
import { toCsv } from '../../apps/web/src/lib/csv';

// US-28: reports can be downloaded as a spreadsheet.
describe('toCsv', () => {
  it('joins cells with commas and lines with CRLF', () => {
    expect(
      toCsv([
        ['Day', 'Net'],
        ['2026-10-20', 225000],
      ]),
    ).toBe('Day,Net\r\n2026-10-20,225000');
  });

  it('quotes cells that hold a comma, a quote or a line break, doubling the quotes', () => {
    expect(toCsv([['Crispy, salted', 'say "hi"', 'two\nlines']])).toBe('"Crispy, salted","say ""hi""","two\nlines"');
  });

  it('leaves empty cells empty and keeps Arabic text as it is', () => {
    expect(toCsv([[null, undefined, 'حليب']])).toBe(',,حليب');
  });

  it('keeps negative numbers as numbers, but turns text that could run as a formula into plain text', () => {
    expect(toCsv([[-5000, '=SUM(A1:A9)', '+961', '@cmd', '-x']])).toBe("-5000,'=SUM(A1:A9),'+961,'@cmd,'-x");
  });
});
