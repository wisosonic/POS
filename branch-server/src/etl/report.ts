// What the legacy import did, and everything in the data that needs a person to look at it.
// The ETL never silently fixes anything: odd rows are imported as faithfully as the new rules allow and listed here.

export type TableCount = { legacy: number; imported: number; existing: number };

export type EtlReport = {
  dump: string;
  startedAt: string;
  finishedAt: string;
  seconds: number;

  /** Per table: rows in the dump, rows added by this run, rows that were already there (a re-run adds none). */
  counts: Record<string, TableCount>;

  /** Money. `netRevenueMatchesLegacy` is checked before anything is saved: a mismatch aborts the whole import. */
  legacyTotals: { saleCount: number; grandTotalLbp: number };
  imported: { revenueLbp: number; refundsLbp: number; netRevenueMatchesLegacy: boolean };

  reconciliation: {
    /** Sales whose header total differs from their lines by the rounding increment or more. Imported as they are. */
    inconsistentSales: { saleId: number; ref: number; roundingLbp: number; linesTotalLbp: number; totalLbp: number }[];
    /** Sales that carried a tax amount (the new system has no tax). The amount is kept in the sale's notes. */
    legacyTaxSales: { saleId: number; ref: number; tax: number }[];
    /** Sale headers with no lines at all in the dump. */
    salesWithoutLines: { saleId: number; ref: number; totalLbp: number }[];
  };

  orphans: { saleProducts: number; purchaseProducts: number; returnsWithoutSale: number; returnLinesWithoutSaleLine: number };

  /** The legacy app edited a sale when something was returned. The original sale is rebuilt and the return kept apart. */
  returns: {
    salesRebuilt: number;
    linesRestored: number;
    /** Returns whose header amount differs from the sum of their lines. The header amount was the refund. */
    headerVsLines: { returnId: number; saleRef: number; headerLbp: number; linesLbp: number }[];
    /** Lines where sold quantity + returned quantity does not equal the original quantity recorded in the return. */
    quantityExceptions: { saleLineId: number; saleRef: number; soldNow: number; returned: number; originalInReturn: number }[];
    /** Returns recorded with no returned lines and nothing refunded. Imported as they were. */
    emptyReturns: { returnId: number; saleRef: number }[];
  };

  skipped: { zeroQuantityLines: number; holds: number; images: string };

  /** Sales where a Walk-In customer still owed money. The new system forbids that, so the debt moved to a placeholder customer. */
  walkInDebts: { saleId: number; ref: number; restLbp: number }[];

  unmatchedLines: { sale: LineMatch; purchase: LineMatch };

  stockAlerts: { imported: number; nullified: number };
  duplicateBarcodes: { barcode: string; products: { legacyId: number; name: string }[] }[];
  currency: { usdProducts: number; lbpProducts: number; usdPurchases: number; lbpPurchases: number };
  negativeStock: { legacyId: number; name: string; qty: number }[];
  receiptNames: { transliterated: number; review: { name: string; receiptName: string }[] };
  images: {
    /** Products that point at a real legacy picture (the rest use the old app's placeholder). */
    referenced: number;
    placeholders: number;
    /** Referenced pictures whose file is in the Uploads folder. */
    present: number;
    /** Referenced pictures with no file in the Uploads folder. The product is imported without a picture. */
    missing: string[];
    /** Different pictures copied into the new pictures folder (the same picture used by several products is kept once). */
    stored: number;
    /** Pictures that several products share. */
    shared: number;
    /** Files whose name said one kind of picture and whose bytes were another (a ".png" that is WebP). Stored under the real kind. */
    extensionFixed: string[];
    /** Referenced files that are not pictures at all (a saved web page). Not copied; the product is imported without a picture. */
    notPictures: string[];
    /** Files in the Uploads folder that no product uses. Not copied: nothing says which product they belong to. */
    unused: number;
  };
  nonCashSales: number;
  /** Numbers in the dump that could not be read and were taken as zero. */
  unreadableNumbers: Record<string, number>;
  users: { legacyId: number; username: string; role: string; note: string }[];
  registers: { openSession: string; closedSessions: number; note: string };
  exchangeRate: { legacy: number; action: string };
  notes: string[];
};

export type LineMatch = { total: number; byCode: number; rescuedByName: number; unmatched: number; distinctUnmatchedCodes: number };

export const emptyReport = (dump: string): EtlReport => ({
  dump,
  startedAt: new Date().toISOString(),
  finishedAt: '',
  seconds: 0,
  counts: {},
  legacyTotals: { saleCount: 0, grandTotalLbp: 0 },
  imported: { revenueLbp: 0, refundsLbp: 0, netRevenueMatchesLegacy: false },
  reconciliation: { inconsistentSales: [], legacyTaxSales: [], salesWithoutLines: [] },
  orphans: { saleProducts: 0, purchaseProducts: 0, returnsWithoutSale: 0, returnLinesWithoutSaleLine: 0 },
  returns: { salesRebuilt: 0, linesRestored: 0, headerVsLines: [], quantityExceptions: [], emptyReturns: [] },
  skipped: {
    zeroQuantityLines: 0,
    holds: 0,
    images:
      'the Images table (binary copies of product pictures) is not imported; the pictures that products use are copied from Uploads/ into the new pictures folder, named by their content',
  },
  walkInDebts: [],
  unmatchedLines: {
    sale: { total: 0, byCode: 0, rescuedByName: 0, unmatched: 0, distinctUnmatchedCodes: 0 },
    purchase: { total: 0, byCode: 0, rescuedByName: 0, unmatched: 0, distinctUnmatchedCodes: 0 },
  },
  stockAlerts: { imported: 0, nullified: 0 },
  duplicateBarcodes: [],
  currency: { usdProducts: 0, lbpProducts: 0, usdPurchases: 0, lbpPurchases: 0 },
  negativeStock: [],
  receiptNames: { transliterated: 0, review: [] },
  images: { referenced: 0, placeholders: 0, present: 0, missing: [], stored: 0, shared: 0, extensionFixed: [], notPictures: [], unused: 0 },
  nonCashSales: 0,
  unreadableNumbers: {},
  users: [],
  registers: { openSession: 'not imported', closedSessions: 0, note: '' },
  exchangeRate: { legacy: 0, action: 'none' },
  notes: [],
});
