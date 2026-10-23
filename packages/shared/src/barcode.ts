// Barcode helpers. Scanners are keyboard wedges: a code arrives as a burst of fast keystrokes ending in Enter (US-01).
// Checksum validation is advisory only: legacy data holds EAN-8 and arbitrary codes, so lookups accept any string.

export type ScanDetectorOptions = {
  onScan: (code: string) => void;
  /** Max gap between keystrokes of one scan. Humans type far slower than this. */
  maxGapMs?: number;
  /** Shortest string accepted as a scan. */
  minLength?: number;
};

export type ScanDetector = {
  /** Feed a key event (KeyboardEvent.key) with a monotonic timestamp in ms. */
  feed(key: string, timeMs: number): void;
  reset(): void;
};

export function createScanDetector({ onScan, maxGapMs = 35, minLength = 6 }: ScanDetectorOptions): ScanDetector {
  let buffer = '';
  let last = 0;

  return {
    feed(key, timeMs) {
      if (key === 'Enter') {
        const fast = buffer.length > 0 && timeMs - last <= maxGapMs;
        const code = buffer;
        buffer = '';
        if (fast && code.length >= minLength) onScan(code);
        return;
      }
      if (key.length !== 1) return; // Shift, Tab, arrows, ...
      if (buffer.length > 0 && timeMs - last > maxGapMs) buffer = ''; // too slow: a human, or a new scan
      buffer += key;
      last = timeMs;
    },
    reset() {
      buffer = '';
    },
  };
}

/** EAN-13 check digit validation. */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

/** Strip control characters (CR/LF from the scanner) and surrounding whitespace. Never rewrites digits. */
export function normalizeBarcode(raw: string): string {
  // eslint-disable-next-line no-control-regex -- scanners append CR/LF and other control characters
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}
