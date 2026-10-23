import { describe, it, expect } from 'vitest';
import { transliterateArabic, toReceiptName } from '@pos/shared/translit';

// R5: Arabic product names are transliterated to Latin for the English-only receipt printer.
// The exact romanization scheme is a product choice, so these tests pin behaviour, not spelling,
// except for a few unambiguous single letters.
const isAscii = (s: string) => [...s].every((c) => c.charCodeAt(0) < 0x80);

describe('translit · transliterateArabic', () => {
  it('output is ASCII only and non-empty for Arabic input', () => {
    for (const name of ['خبز كبير', 'شكراً', 'لبنة', 'زيت زيتون', 'حليب']) {
      const out = transliterateArabic(name);
      expect(out.length).toBeGreaterThan(0);
      expect(isAscii(out)).toBe(true);
    }
  });

  it('maps unambiguous letters', () => {
    expect(transliterateArabic('ب').toLowerCase()).toBe('b');
    expect(transliterateArabic('م').toLowerCase()).toBe('m');
    expect(transliterateArabic('ن').toLowerCase()).toBe('n');
    expect(transliterateArabic('ك').toLowerCase()).toBe('k');
  });

  it('keeps Latin letters, digits, punctuation and spaces untouched', () => {
    expect(transliterateArabic('Master Chips 80g (BBQ)')).toBe('Master Chips 80g (BBQ)');
  });

  it('transliterates only the Arabic parts of a mixed name', () => {
    const out = transliterateArabic('Al safa خبز كبير ');
    expect(out.startsWith('Al safa ')).toBe(true);
    expect(isAscii(out)).toBe(true);
  });

  it('removes diacritics and tatweel without leaving junk', () => {
    expect(transliterateArabic('شُكْرًا')).toBe(transliterateArabic('شكرا'));
    expect(transliterateArabic('كـتـاب')).toBe(transliterateArabic('كتاب'));
  });

  it('converts Arabic-Indic digits to ASCII digits', () => {
    expect(transliterateArabic('٢٥٠ غرام')).toMatch(/^250 /);
  });

  it('handles empty and whitespace-only input', () => {
    expect(transliterateArabic('')).toBe('');
    expect(transliterateArabic('   ')).toBe('   ');
  });

  it('is deterministic', () => {
    expect(transliterateArabic('خبز كبير')).toBe(transliterateArabic('خبز كبير'));
  });

  it('replaces any other unprintable character with "?" (never throws)', () => {
    const out = transliterateArabic('Tea 🍵 中');
    expect(isAscii(out)).toBe(true);
    expect(out.startsWith('Tea ')).toBe(true);
  });
});

describe('translit · toReceiptName', () => {
  it('uses the manual receiptName when provided (the owner can override the machine output)', () => {
    expect(toReceiptName({ name: 'خبز كبير', receiptName: 'Big bread' })).toBe('Big bread');
  });

  it('falls back to transliterating the name', () => {
    const out = toReceiptName({ name: 'خبز كبير', receiptName: null });
    expect(isAscii(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });

  it('returns Latin names unchanged and trimmed', () => {
    expect(toReceiptName({ name: '  Cedars silver towel ', receiptName: null })).toBe('Cedars silver towel');
  });

  it("truncates nothing (wrapping is the receipt renderer's job)", () => {
    const long = 'A'.repeat(80);
    expect(toReceiptName({ name: long, receiptName: null })).toBe(long);
  });
});
