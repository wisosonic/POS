import { describe, it, expect, vi } from 'vitest';
import { createScanDetector, isValidEan13, normalizeBarcode } from '@pos/shared/barcode';

// Keyboard-wedge scanners type a code as a very fast burst of keys ending with Enter (US-01).
function burst(detector: ReturnType<typeof createScanDetector>, text: string, startMs: number, gapMs: number, enter = true) {
  let t = startMs;
  for (const ch of text) {
    detector.feed(ch, t);
    t += gapMs;
  }
  if (enter) detector.feed('Enter', t);
  return t;
}

describe('barcode · ScanDetector', () => {
  it('emits a scan for a fast burst ending in Enter', () => {
    const onScan = vi.fn();
    const d = createScanDetector({ onScan, maxGapMs: 35, minLength: 6 });
    burst(d, '5287000107945', 1000, 8);
    expect(onScan).toHaveBeenCalledOnce();
    expect(onScan).toHaveBeenCalledWith('5287000107945');
  });

  it('ignores human-speed typing', () => {
    const onScan = vi.fn();
    const d = createScanDetector({ onScan, maxGapMs: 35, minLength: 6 });
    burst(d, '5287000107945', 1000, 150);
    expect(onScan).not.toHaveBeenCalled();
  });

  it('ignores bursts shorter than minLength', () => {
    const onScan = vi.fn();
    const d = createScanDetector({ onScan, maxGapMs: 35, minLength: 6 });
    burst(d, '123', 1000, 5);
    expect(onScan).not.toHaveBeenCalled();
  });

  it('handles two scans back to back', () => {
    const onScan = vi.fn();
    const d = createScanDetector({ onScan, maxGapMs: 35, minLength: 6 });
    const t = burst(d, '5287000107945', 1000, 8);
    burst(d, '9342390005250', t + 400, 8);
    expect(onScan.mock.calls.map((c) => c[0])).toEqual(['5287000107945', '9342390005250']);
  });

  it('a slow key mid-burst discards the partial buffer', () => {
    const onScan = vi.fn();
    const d = createScanDetector({ onScan, maxGapMs: 35, minLength: 6 });
    d.feed('1', 0);
    d.feed('2', 10);
    d.feed('3', 500); // too slow → restart with "3"
    burst(d, '5287000107945', 800, 8); // starts well after the slow key, so it is a fresh scan
    expect(onScan).toHaveBeenCalledWith('5287000107945');
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('does not emit for non-printable keys such as Shift', () => {
    const onScan = vi.fn();
    const d = createScanDetector({ onScan, maxGapMs: 35, minLength: 6 });
    d.feed('Shift', 0);
    burst(d, '5287000107945', 5, 8);
    expect(onScan).toHaveBeenCalledWith('5287000107945');
  });
});

describe('barcode · EAN-13 checksum (advisory only)', () => {
  it.each([
    '5287000107945',
    '9342390005250',
  ]) // codes from the legacy data
  ('accepts valid %s', (code) => {
    expect(isValidEan13(code)).toBe(true);
  });

  it('rejects a bad check digit', () => {
    expect(isValidEan13('5287000107946')).toBe(false);
  });

  it('rejects wrong length and non-digits', () => {
    expect(isValidEan13('528700010794')).toBe(false);
    expect(isValidEan13('52870001079ab')).toBe(false);
  });
});

describe('barcode · normalizeBarcode', () => {
  it('trims whitespace and control characters', () => {
    expect(normalizeBarcode(' 5287000107945\r\n')).toBe('5287000107945');
  });

  it('keeps legacy non-EAN codes (e.g. EAN-8) untouched', () => {
    expect(normalizeBarcode('84191069')).toBe('84191069');
  });
});
