// Arabic → Latin transliteration for the English-only (ASCII) receipt printer (decision R5).
// Arabic is written without short vowels, so the machine output is a readable consonant skeleton
// (e.g. "khbz kbyr"). The owner can override any product with a manual receipt name.

const LETTERS: Record<string, string> = {
  ء: "'",
  آ: 'a',
  أ: 'a',
  ؤ: 'u',
  إ: 'i',
  ئ: 'e',
  ا: 'a',
  ب: 'b',
  ة: 'a',
  ت: 't',
  ث: 'th',
  ج: 'j',
  ح: 'h',
  خ: 'kh',
  د: 'd',
  ذ: 'dh',
  ر: 'r',
  ز: 'z',
  س: 's',
  ش: 'sh',
  ص: 's',
  ض: 'd',
  ط: 't',
  ظ: 'z',
  ع: "'",
  غ: 'gh',
  ف: 'f',
  ق: 'q',
  ك: 'k',
  ل: 'l',
  م: 'm',
  ن: 'n',
  ه: 'h',
  و: 'w',
  ي: 'y',
  ى: 'a',
  ٱ: 'a',
  // Persian / extended letters sometimes used in Lebanese product names
  پ: 'p',
  چ: 'ch',
  ڤ: 'v',
  ژ: 'zh',
  گ: 'g',
  ک: 'k',
  ی: 'y',
  // punctuation
  '،': ',',
  '؛': ';',
  '؟': '?',
  '٪': '%',
};

const DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g; // harakat, dagger alef, Quranic marks, tatweel
const COMBINING = /[\u0300-\u036F]/g;

function digitFor(cp: number): string | undefined {
  if (cp >= 0x0660 && cp <= 0x0669) return String(cp - 0x0660); // Arabic-Indic
  if (cp >= 0x06f0 && cp <= 0x06f9) return String(cp - 0x06f0); // Persian
  return undefined;
}

const isAscii = (s: string) => [...s].every((c) => c.charCodeAt(0) < 0x80);

/** Convert any text to printable ASCII. Arabic letters are transliterated, accents stripped, anything else becomes "?". */
export function transliterateArabic(text: string): string {
  const input = text.normalize('NFKC').replace(DIACRITICS, '');
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      out += ch;
      continue;
    }
    const digit = digitFor(cp);
    if (digit !== undefined) {
      out += digit;
      continue;
    }
    const mapped = LETTERS[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const stripped = ch.normalize('NFKD').replace(COMBINING, '');
    out += stripped.length > 0 && isAscii(stripped) ? stripped : '?';
  }
  return out;
}

/** The name printed on receipts: the manual receiptName if set, otherwise the transliterated name. */
export function toReceiptName(product: { name: string; receiptName?: string | null }): string {
  const manual = product.receiptName?.trim();
  const base = manual ? manual : product.name;
  return transliterateArabic(base).replace(/\s+/g, ' ').trim();
}
