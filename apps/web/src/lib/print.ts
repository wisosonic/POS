import { ApiError, api, post } from './api';

/** Send the receipt to the USB printer through the server. Rejects with an ApiError the till shows as "Retry". */
export const printOnPrinter = (saleId: number, duplicate = false): Promise<void> =>
  post(`/sales/${saleId}/print`, duplicate ? { duplicate: true } : {}).then(() => undefined);

/**
 * Print through the browser's print dialog, in the 42-column receipt layout. The fallback for when the USB printer is not
 * set up or is off. The receipt text is the same ASCII the printer would get.
 */
export async function printInBrowser(saleId: number, duplicate = false): Promise<void> {
  const text = await api<string>('GET', `/sales/${saleId}/receipt?format=text${duplicate ? '&duplicate=true' : ''}`);
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    throw new ApiError(0, 'PRINT_UNAVAILABLE', 'The browser could not open a print window');
  }
  doc.open();
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: 80mm auto; margin: 2mm }
      body { margin: 0; font: 11px/1.25 "Courier New", monospace; width: 76mm }
      pre { margin: 0; white-space: pre-wrap; word-break: break-all }
    </style></head><body><pre></pre></body></html>`,
  );
  doc.close();
  doc.querySelector('pre')!.textContent = text; // textContent: the receipt is data, never markup
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  setTimeout(() => frame.remove(), 60_000);
}

let audio: AudioContext | undefined;
/** A short tone so the cashier knows a scan worked (high) or failed (low) without looking. */
export function beep(kind: 'ok' | 'error') {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = kind === 'ok' ? 880 : 200;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + (kind === 'ok' ? 0.06 : 0.22));
  } catch {
    /* no audio: the toast still shows */
  }
}
