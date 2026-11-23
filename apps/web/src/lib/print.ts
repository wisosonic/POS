import { ApiError, api, get, post } from './api';

type JobState = { status: 'queued' | 'sent' | 'printed' | 'failed' | 'cancelled' | 'expired'; error: string | null };
export type JobDeps = {
  job: (id: number) => Promise<JobState>;
  cancel: (id: number) => Promise<JobState>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};
const realDeps: JobDeps = {
  job: (id) => get<JobState>(`/print-jobs/${id}`),
  cancel: (id) => post<JobState>(`/print-jobs/${id}/cancel`),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/**
 * Wait for a receipt queued for this till's print agent to come out of the printer. Resolves when it printed; rejects with an ApiError
 * (shown as "Retry" / "Use browser print") when it failed, or when the printer's computer does not answer in `waitMs`. In that case
 * the queued job is cancelled first, so it cannot print later on top of a browser print. A job the agent has already taken is given a
 * few more seconds, because it is about to print.
 */
export async function waitForPrintJob(id: number, deps: JobDeps = realDeps, waitMs = 15_000, graceMs = 8_000): Promise<void> {
  let deadline = deps.now() + waitMs;
  let cancelled = false;
  for (;;) {
    const job = await deps.job(id);
    if (job.status === 'printed') return;
    if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'expired')
      throw new ApiError(503, 'PRINTER_OFFLINE', job.error ?? 'The printer did not print');
    if (deps.now() >= deadline) {
      if (cancelled) throw new ApiError(503, 'PRINTER_OFFLINE', 'The computer with the printer is not answering');
      cancelled = true;
      const after = await deps.cancel(id);
      if (after.status === 'printed') return;
      if (after.status !== 'sent') throw new ApiError(503, 'PRINTER_OFFLINE', 'The computer with the printer is not answering');
      deadline = deps.now() + graceMs; // already with the agent: a few more seconds
    }
    await deps.sleep(700);
  }
}

/**
 * Send the receipt to the receipt printer through the server. With a print agent on this till the server only queues it (202) and
 * this waits until it has really printed. Rejects with an ApiError the till shows as "Retry".
 */
export async function printOnPrinter(saleId: number, duplicate = false): Promise<void> {
  const res = await post<{ queued?: boolean; jobId?: number }>(`/sales/${saleId}/print`, duplicate ? { duplicate: true } : {});
  if (res.queued && res.jobId !== undefined) await waitForPrintJob(res.jobId);
}

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
