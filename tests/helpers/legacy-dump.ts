import { writeFileSync } from 'node:fs';

// Builds a small T-SQL dump in the same shape as the real one, so the ETL can be tested without the 157 MB file.

export type Cell = string | number | null;
export type Table = Record<string, Cell>[];
export type Tables = Record<string, Table>;

const literal = (v: Cell) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `N'${v.replaceAll("'", "''")}'`);

export function dumpText(tables: Tables): string {
  const parts = ['\uFEFF-- Dump of database [POSDB] (synthetic, for tests)', 'SET NOCOUNT ON;', 'GO'];
  for (const [name, rows] of Object.entries(tables)) {
    if (rows.length === 0) continue;
    const columns = Object.keys(rows[0]!);
    parts.push(`SET IDENTITY_INSERT [dbo].[${name}] ON;`, 'GO');
    parts.push(`INSERT INTO [dbo].[${name}] (${columns.map((c) => `[${c}]`).join(', ')}) VALUES`);
    parts.push(rows.map((r) => `(${columns.map((c) => literal(r[c] ?? null)).join(', ')})`).join(',\n') + ';', 'GO');
    parts.push(`SET IDENTITY_INSERT [dbo].[${name}] OFF;`, 'GO');
  }
  return parts.join('\n') + '\n';
}

export function writeDump(path: string, tables: Tables): string {
  writeFileSync(path, dumpText(tables), 'utf8');
  return path;
}

// ---------------------------------------------------------------- a small, deliberately awkward shop

type Line = { id: number; ref: string; name: string; code: string; qty: number; price: number; subtotal?: number; cost?: number };
export const line = (l: Line): Record<string, Cell> => ({
  SPID: l.id,
  SPreference: l.ref,
  SPName: l.name,
  SPinstock: '0',
  SPbrand: 'Cedars ',
  SPunit: 'Piece ',
  SPcode: l.code,
  SPqty: l.qty,
  SPprice: String(l.price),
  SPcurrency: '.ل.ل',
  SPsubtotal: String(l.subtotal ?? l.qty * l.price),
  SPcost: String(l.cost ?? 0),
  spDate: '2026-01-15 12:00:00',
});

type SaleArgs = {
  id: number;
  ref: string;
  total: number;
  paid?: number;
  rest?: number;
  customer?: number;
  date?: string;
  tax?: number;
  discount?: number;
  profit?: number;
};
export const sale = (s: SaleArgs): Record<string, Cell> => ({
  SaleID: s.id,
  reference: s.ref,
  grandTotal: String(s.total),
  paidAmount: String(s.paid ?? s.total - (s.rest ?? 0)),
  restAmount: String(s.rest ?? 0),
  tax: String(s.tax ?? 0),
  shipping: '0',
  discount: String(s.discount ?? 0),
  paymentStatus: 'Paid',
  paymentType: 'cash',
  sDate: s.date ?? '2026-01-15 12:00:00',
  rate: '90000',
  CustomerID: s.customer ?? 1,
  WarehouseID: 1,
  currency: '.ل.ل',
  profit: String(s.profit ?? 0),
  notes: '',
  secCurRecAmount: '0',
  mainCurRecAmount: String(s.total),
  UserID: 1,
});

export const product = (p: {
  id: number;
  name: string;
  code: string;
  cost?: number;
  price?: number;
  qty?: string;
  alert?: string;
  image?: string;
}): Record<string, Cell> => ({
  ProductID: p.id,
  ProductName: p.name,
  ProductCode: p.code,
  ProductCost: p.cost ?? 1,
  ProductPrice: p.price ?? 2,
  ProductSerial: '0',
  ProductQuantity: p.qty ?? '0',
  StockAlert: p.alert ?? '0',
  PDate: '2026-01-10 09:00:00.5',
  CategoryID: 1,
  SupplierID: 1,
  BrandID: 1,
  WarehouseID: 1,
  UnitID: 2,
  ProdImage: p.image ?? 'http://localhost:5220/uploads/null.png',
  expiryDate: '0001-01-01T00:00:00.0000000',
});

export const returnRow = (r: {
  id: number;
  saleRef: string;
  refund: number;
  date?: string;
  items: Record<string, unknown>[];
}): Record<string, Cell> => ({
  RSaleID: r.id,
  rsreference: r.saleRef,
  rsgrandTotal: String(r.refund),
  returnedsAmount: String(r.refund),
  rsrestAmount: '0',
  rspaymentStatus: 'Paid',
  rspaymentType: 'Cash',
  rsDate: r.date ?? '2026-07-01 13:00:00',
  rslist: JSON.stringify(r.items),
  rscurrency: '.ل.ل',
  CustomerID: 1,
  WarehouseID: 1,
});

export function smallShop(): Tables {
  return {
    Warehouses: [
      { WarehouseID: 1, warehouseName: 'Main Stock', warehouseAddress: 'lebanon', warehouseEmail: 'a@b.c', warehousePhone: '1' },
    ],
    Units: [
      { UnitID: 2, unitName: 'Piece ' },
      { UnitID: 3, unitName: 'KG' },
      { UnitID: 6, unitName: 'Liter' },
    ],
    Brands: [{ BrandID: 1, brandName: 'Cedars ' }],
    Categorys: [{ CategoryID: 1, categoryName: 'Grocery ' }],
    Suppliers: [{ SupplierID: 1, supplierName: 'Acme  Trading', supplierAddress: 'Beirut', supplierEmail: '', supplierPhone: '03 111' }],
    Customers: [
      { CustomerID: 1, customerName: 'Walk-In', customerPhone: '12345', customerAddress: 'Beirut', customerEmail: 'x@y.z' },
      { CustomerID: 2, customerName: 'Ahmad  Darwish', customerPhone: '', customerAddress: '', customerEmail: '' },
    ],
    Users: [
      {
        UserID: 1,
        userName: 'Atom Support',
        userImage: '',
        userType: 'Admin',
        userPassword: 'LegacySecret-1',
        userPhone: '71',
        userEmail: 'a@b.c',
      },
    ],
    Settings: [
      {
        CompanyID: 1,
        companyLogo: '',
        companyName: 'Test Market',
        companyEmail: 'm@x.y',
        companyAddress: 'Tyre',
        companyPhone: '07',
        WarehouseID: 1,
        CustomerID: 1,
      },
    ],
    Exchanges: [{ ExchangeID: 1, Currency: '.ل.ل', Rate: '90000' }],
    Products: [
      product({
        id: 10,
        name: 'Cedars towel',
        code: '111',
        cost: 0.75,
        price: 0.83,
        qty: '10',
        alert: '3',
        image: 'http://localhost:5220/uploads/towel.jpg',
      }),
      product({ id: 11, name: 'خبز كبير', code: '222', cost: 1, price: 1.5, qty: '-2', alert: '0' }),
      product({ id: 12, name: 'Twin A', code: '333', qty: '1' }),
      product({ id: 13, name: 'Twin B', code: '333', qty: '1' }),
    ],
    Sales: [
      sale({ id: 100, ref: '5001', total: 75000, profit: 8000 }), // an ordinary sale, in winter time
      sale({ id: 101, ref: '5002', total: 0, date: '2026-07-01 12:00:00', profit: 0 }), // zeroed by its return, in summer time
      sale({ id: 102, ref: '5003', total: 100000, rest: 60000, customer: 1 }), // Walk-In still owes 60,000
      sale({ id: 103, ref: '5004', total: 50000, customer: 2 }), // has a leftover zero line
      sale({ id: 104, ref: '5005', total: 30000 }), // header 30,000 but lines add up to 65,000
    ],
    SaleProducts: [
      line({ id: 1001, ref: '5001', name: 'Cedars towel', code: '111', qty: 1, price: 75000, cost: 67000 }),
      line({ id: 2001, ref: '5002', name: 'Cedars towel', code: '111', qty: 0, price: 75000, subtotal: 0, cost: 67000 }),
      line({ id: 3001, ref: '5003', name: 'Twin B', code: '333', qty: 2, price: 50000 }),
      line({ id: 4001, ref: '5004', name: 'Cedars towel', code: '111', qty: 1, price: 50000 }),
      line({ id: 4002, ref: '5004', name: 'Cedars towel', code: '111', qty: 0, price: 50000, subtotal: 0 }),
      line({ id: 5001, ref: '5005', name: 'Not in the catalog any more', code: '999', qty: 1, price: 40000 }),
      line({ id: 5002, ref: '5005', name: 'خبز كبير', code: 'no-such-code', qty: 1, price: 25000 }),
    ],
    SaleReturn: [
      returnRow({
        id: 7,
        saleRef: '5002',
        refund: 150000,
        items: [
          {
            id: 2001,
            reference: 5002,
            name: 'Cedars towel',
            qty: 2,
            price: 75000,
            cost: 67000,
            rqty: 2,
            rsubtotal: '150000.00',
            code: '111',
          },
        ],
      }),
    ],
  };
}
