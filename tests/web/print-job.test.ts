import { describe, it, expect } from 'vitest';
import { ApiError } from '../../apps/web/src/lib/api';
import { waitForPrintJob, type JobDeps } from '../../apps/web/src/lib/print';

// US-06: with a print agent the server only queues the receipt. The till waits for it to really print, and when the printer's computer
// does not answer it gives up WITHOUT leaving a job behind that could print later on top of a browser print.
type State = { status: 'queued' | 'sent' | 'printed' | 'failed' | 'cancelled' | 'expired'; error: string | null };
const ok = (status: State['status'], error: string | null = null): State => ({ status, error });

/** A fake clock: each sleep moves time forward, so a test of a 15 second wait takes no time. */
function setup(states: State[], cancelStates: State[] = [ok('cancelled')]) {
  let t = 0;
  const calls: string[] = [];
  const deps: JobDeps = {
    job: async () => (calls.push('job'), states.shift() ?? states[states.length - 1] ?? ok('queued')),
    cancel: async () => (calls.push('cancel'), cancelStates.shift() ?? ok('cancelled')),
    sleep: async (ms) => void (t += ms),
    now: () => t,
  };
  return { deps, calls };
}
const reason = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as ApiError,
  );

describe('waiting for a receipt queued for the print agent', () => {
  it('returns as soon as the agent says it printed', async () => {
    const { deps, calls } = setup([ok('queued'), ok('sent'), ok('printed')]);
    await expect(waitForPrintJob(1, deps)).resolves.toBeUndefined();
    expect(calls).toEqual(['job', 'job', 'job']);
  });

  it('a failed print rejects with the printer’s reason, so the till offers Retry and browser print', async () => {
    const { deps } = setup([ok('sent'), ok('failed', 'Printer is out of paper')]);
    const e = await reason(waitForPrintJob(1, deps));
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 503, code: 'PRINTER_OFFLINE', message: 'Printer is out of paper' });
  });

  it('a job that expired or was cancelled elsewhere also rejects', async () => {
    expect(await reason(waitForPrintJob(1, setup([ok('expired')]).deps))).toMatchObject({ code: 'PRINTER_OFFLINE' });
    expect(await reason(waitForPrintJob(1, setup([ok('cancelled')]).deps))).toMatchObject({ code: 'PRINTER_OFFLINE' });
  });

  it('when nobody picks it up in 15 seconds it cancels the job first, then rejects', async () => {
    const { deps, calls } = setup([ok('queued')], [ok('cancelled')]);
    const e = await reason(waitForPrintJob(1, deps));
    expect(e).toMatchObject({ status: 503, code: 'PRINTER_OFFLINE', message: 'The computer with the printer is not answering' });
    expect(calls.filter((c) => c === 'cancel')).toHaveLength(1);
    expect(calls[calls.length - 1]).toBe('cancel'); // nothing is left in the queue to print later
  });

  it('a job the agent has already taken gets a few more seconds, and counts if it prints in time', async () => {
    const { deps } = setup([ok('queued'), ok('sent')], [ok('sent')]);
    // stays "sent" for a while after the 15 s limit, then prints
    let n = 0;
    const base = deps.job;
    deps.job = async (id) => (n++ > 25 ? ok('printed') : base(id));
    await expect(waitForPrintJob(1, deps)).resolves.toBeUndefined();
  });

  it('if it prints at the very moment the till cancels, that counts as printed (no second copy by browser)', async () => {
    const { deps } = setup([ok('queued')], [ok('printed')]);
    await expect(waitForPrintJob(1, deps)).resolves.toBeUndefined();
  });

  it('a job the agent took but that never finishes is given up on after the grace period', async () => {
    const { deps } = setup([ok('sent')], [ok('sent')]);
    expect(await reason(waitForPrintJob(1, deps))).toMatchObject({ code: 'PRINTER_OFFLINE' });
  });
});
