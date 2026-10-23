// Shapes returned by the API (docs/06-api-spec.md). Only what the till uses.
export type Currency = 'USD' | 'LBP';
export type Method = 'cash' | 'whish' | 'omt';
export type Role = 'cashier' | 'manager' | 'admin';

export type User = { id: number; username: string; name: string; role: Role; mustResetPassword?: boolean };

export type Product = {
  id: number;
  name: string;
  receiptName: string | null;
  barcode: string;
  costMinor: number;
  priceMinor: number;
  currency: Currency;
  qty: string;
  unitName: string | null;
  /** Sold by weight or volume: the quantity may have up to 3 decimals. */
  fractional: boolean;
  stockAlert: number | null;
  active: boolean;
  updatedAt: string;
  /** `/uploads/<name>` when the product has a picture. */
  imagePath?: string | null;
};

/** The full product as the back office edits it (the till only needs `Product`). */
export type ProductFull = Product & {
  receiptNameManual: boolean;
  categoryId: number | null;
  brandId: number | null;
  unitId: number | null;
  supplierId: number | null;
  expiryDate: string | null;
};

export type Lookup = { id: number; name: string };
export type UnitLookup = Lookup & { fractional: boolean };
export type SupplierLookup = Lookup & { address: string | null; phone: string | null; email: string | null };
export type LookupKind = 'categories' | 'brands' | 'units' | 'suppliers' | 'expense-categories' | 'service-categories';

export type Expense = {
  id: number;
  title: string;
  categoryId: number | null;
  categoryName: string | null;
  amountMinor: number;
  currency: Currency;
  reference: string;
  note: string | null;
  paidFromRegister: boolean;
  createdAt: string;
};

export type CashMovement = {
  id: number;
  type: 'in' | 'out' | 'transfer';
  from: { method: Method; currency: Currency } | null;
  to: { method: Method; currency: Currency } | null;
  amount: number;
  reason: string;
  userName: string | null;
  createdAt: string;
};

export type PurchaseStatus = 'draft' | 'ordered' | 'received';
export type PurchaseItem = {
  id: number;
  productId: number | null;
  name: string;
  qty: string;
  costMinor: number;
  lineTotalMinor: number;
  received: string;
  outstanding: string;
};
export type Purchase = {
  id: number;
  ref: number;
  supplierId: number | null;
  supplierName: string | null;
  status: PurchaseStatus;
  currency: Currency;
  totalMinor: number;
  paidMinor: number;
  owedMinor: number;
  createdAt: string;
  receivedAt: string | null;
  items: PurchaseItem[];
};

export type SaleDetail = {
  id: number;
  ref: number;
  status: string;
  customerId: number;
  totalLbp: number;
  paidLbp: number;
  restLbp: number;
  createdAt: string;
  items: {
    id: number;
    productId: number | null;
    name: string;
    qty: string;
    returnedQty: string;
    unitPriceLbp: number;
    lineTotalLbp: number;
  }[];
};

/** One row of the recent-sales list. */
export type SaleListItem = {
  id: number;
  ref: number;
  status: 'paid' | 'partial' | 'unpaid' | 'void';
  totalLbp: number;
  paidLbp: number;
  restLbp: number;
  createdAt: string;
  customerId: number;
  customerName: string;
  userName: string | null;
};

export type ReturnRecord = {
  id: number;
  ref: number;
  saleId: number;
  reason: string;
  refundLbp: number;
  balanceReducedLbp: number;
  createdAt: string;
  items: { saleItemId: number; qty: string; amountLbp: number }[];
};

export type StockMovement = {
  id: number;
  qtyDelta: string;
  reason: string;
  refType: string | null;
  note: string | null;
  createdAt: string;
};

export type FullSettings = {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  lbpRounding: number;
  receiptFooter: string;
  receiptWidth: number;
  printerName: string | null;
  cashierDiscountLimitPct: number;
};
export type RateRow = { id: number; rateLbpPerUsd: number; effectiveFrom: string; createdAt: string };

export type BackupStatus = {
  configured: boolean;
  encrypted: boolean;
  hasSecondCopy: boolean;
  at: string;
  keep: number;
  lastBackupAt: string | null;
  stale: boolean;
  lastRunOk: boolean | null;
};
export type BackupFile = { file: string; bytes: number; modifiedAt: string; encrypted: boolean };
export type BackupDetail = Omit<BackupStatus, 'lastRunOk'> & {
  lastRun: { at: string; ok: boolean; trigger: 'schedule' | 'manual'; file?: string; error?: string; copyError?: string } | null;
  files: BackupFile[];
};

export type Dashboard = {
  today: {
    salesCount: number;
    grossLbp: number;
    returnsCount: number;
    returnedLbp: number;
    netLbp: number;
    profitLbp: number;
    averageBasketLbp: number;
  };
  hourly: { hour: number; count: number; totalLbp: number }[];
  topItems: { productId: number | null; name: string; qty: string; totalLbp: number }[];
  owedByCustomersLbp: number;
  owedToSuppliers: { USD: number; LBP: number };
  lowStockCount: number;
  openRegisters: number;
};

export type SalesRow = {
  key: string;
  label: string;
  count: number;
  grossLbp: number;
  returnedLbp: number;
  netLbp: number;
  profitLbp: number;
};
export type SalesReport = { from: string; to: string; data: SalesRow[]; totals: Omit<SalesRow, 'key' | 'label'> };
export type ProductReportRow = {
  productId: number | null;
  name: string;
  qty: string;
  revenueLbp: number;
  costLbp: number;
  profitLbp: number;
};
export type Receivable = {
  customerId: number;
  name: string;
  phone: string | null;
  balanceLbp: number;
  oldestUnpaidAt: string | null;
  openSales: number;
};
export type Payable = {
  purchaseId: number;
  ref: number;
  supplierName: string | null;
  currency: Currency;
  totalMinor: number;
  paidMinor: number;
  owedMinor: number;
  status: string;
  createdAt: string;
};
export type SessionSummary = {
  id: number;
  status: 'open' | 'closed';
  openedAt: string;
  closedAt: string | null;
  balances: { method: Method; currency: Currency; opening: number; expected: number; counted?: number | null; variance?: number | null }[];
};
export type ZReport = Omit<SessionSummary, 'balances'> & {
  balances: (SessionSummary['balances'][number] & {
    salesIn: number;
    changeOut: number;
    customerPaymentsIn: number;
    refundsOut: number;
    movementsNet: number;
  })[];
  totals: {
    salesCount: number;
    salesTotalLbp: number;
    salesProfitLbp: number;
    owedOnAccountLbp: number;
    customerPaymentsCount: number;
    refundsCount: number;
    movementsCount: number;
  };
};

export type Customer = { id: number; name: string; phone: string | null; balanceLbp: number; isWalkIn: boolean };

export type LowStockItem = { productId: number; name: string; qty: string; threshold: number | null };

export type SaleResult = {
  id: number;
  ref: number;
  status: 'paid' | 'partial' | 'unpaid';
  totalLbp: number;
  receivedLbp: number;
  changeLbp: number;
  restLbp: number;
  lowStock: LowStockItem[];
};

export type Balance = { method: Method; currency: Currency; opening: number; expected: number };
export type RegisterSession = { id: number; terminalId: string; status: 'open' | 'closed'; openedAt: string; balances: Balance[] };

export type PublicSettings = {
  name: string;
  address: string | null;
  phone: string | null;
  lbpRounding: number;
  receiptFooter: string;
  receiptWidth: number;
  cashierDiscountLimitPct: number;
  printerConfigured: boolean;
};

export type HoldSummary = {
  id: number;
  userName: string | null;
  customerName: string | null;
  note: string;
  createdAt: string;
  itemCount: number;
  totalLbp: number;
  items: { productId: number; name: string; qty: string; priceLbp: number }[];
};

export type RecalledHold = {
  id: number;
  customerId: number | null;
  note: string;
  items: {
    productId: number;
    name: string;
    qty: string;
    priceLbp: number;
    currentPriceLbp: number;
    priceChanged: boolean;
    active: boolean;
  }[];
};
