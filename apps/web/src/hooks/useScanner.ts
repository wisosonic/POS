import { createScanDetector } from '@pos/shared';
import { useEffect, useRef } from 'react';

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/**
 * Listen for a barcode scanner. A keyboard-wedge scanner "types" the code as a very fast burst of keys ending in Enter,
 * so the cashier never has to click a box first. Ignored while a field or a dialog has the focus (the scanner is then
 * just typing into that field, which handles Enter itself).
 */
export function useScanner(onScan: (code: string) => void, enabled = true) {
  const callback = useRef(onScan);
  callback.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    const detector = createScanDetector({ onScan: (code) => callback.current(code), maxGapMs: 50, minLength: 4 });
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (typing(e.target) || document.querySelector('dialog[open]')) {
        detector.reset();
        return;
      }
      detector.feed(e.key, e.timeStamp);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
