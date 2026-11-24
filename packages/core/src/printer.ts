import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Sending raw ESC/POS bytes to the USB receipt printer. The API runs on the till PC, so it talks to the Windows print
// spooler directly (decision Q2): no WebUSB, no separate print agent. A failure never affects the sale, which is
// already saved by the time anyone tries to print.

export class PrinterError extends Error {
  constructor(
    readonly code: 'PRINTER_NOT_CONFIGURED' | 'PRINTER_OFFLINE' | 'PRINTER_UNSUPPORTED',
    message: string,
  ) {
    super(message);
    this.name = 'PrinterError';
  }
}

export interface ReceiptPrinter {
  /** Send the bytes to the named printer (its Windows queue name). Rejects with a PrinterError. */
  print(bytes: Uint8Array, printerName: string): Promise<void>;
}

// Classic raw printing through winspool.drv: OpenPrinter, StartDocPrinter with the RAW data type, WritePrinter.
// Works with any installed printer by name, shared or not. The bytes are read from a file so nothing is escaped into the command.
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PosRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string Name; [MarshalAs(UnmanagedType.LPWStr)] public string Output; [MarshalAs(UnmanagedType.LPWStr)] public string DataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] bytes, int count, out int written);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Cannot open printer '" + printer + "' (error " + Marshal.GetLastWin32Error() + ")");
    try {
      var di = new DOCINFO { Name = "POS receipt", DataType = "RAW" };
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter failed (error " + Marshal.GetLastWin32Error() + ")");
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter failed (error " + Marshal.GetLastWin32Error() + ")");
        int written;
        if (!WritePrinter(h, data, data.Length, out written) || written != data.Length) throw new Exception("WritePrinter wrote " + written + " of " + data.Length + " bytes");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@
[PosRawPrinter]::Send($env:POS_PRINTER, [System.IO.File]::ReadAllBytes($env:POS_FILE))
`;

/** Raw printing through the Windows print spooler. Only works on Windows. */
export const windowsSpoolerPrinter: ReceiptPrinter = {
  async print(bytes, printerName) {
    if (process.platform !== 'win32')
      throw new PrinterError('PRINTER_UNSUPPORTED', 'Direct printing needs Windows; use the browser print fallback');
    if (!printerName.trim()) throw new PrinterError('PRINTER_NOT_CONFIGURED', 'No printer name is set');

    const dir = mkdtempSync(join(tmpdir(), 'pos-print-'));
    const file = join(dir, 'receipt.bin');
    writeFileSync(file, bytes);
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SCRIPT],
          { env: { ...process.env, POS_PRINTER: printerName, POS_FILE: file }, timeout: 15_000, windowsHide: true },
          (err, _stdout, stderr) => {
            if (!err) return resolve();
            const detail =
              String(stderr || err.message)
                .split('\n')
                .find((l) => l.trim()) ?? 'unknown error';
            reject(
              new PrinterError(
                'PRINTER_OFFLINE',
                detail
                  .trim()
                  .replace(/^Exception calling .*?: "?/, '')
                  .replace(/"?$/, ''),
              ),
            );
          },
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
