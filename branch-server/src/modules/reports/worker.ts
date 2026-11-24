import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../db/open';
import { runReport, type ReportJob } from './compute';

// The reports worker (modules/reports/runner.ts): a thread with its OWN read-only connection to the database file. In WAL mode a reader
// never blocks the writer and the writer never blocks a reader, so a report that takes a second leaves the till's thread free to
// sell. It never writes: the connection is opened read-only, so even a bug here cannot change a figure.
const port = parentPort!;
const db = openDatabase((workerData as { databasePath: string }).databasePath, { readonly: true });

port.on('message', (msg: { id: number; job: ReportJob }) => {
  try {
    port.postMessage({ id: msg.id, ok: true, result: runReport(db, msg.job) });
  } catch (e) {
    port.postMessage({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
