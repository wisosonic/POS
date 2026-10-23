import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, useEffect, type ComponentType } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { TillLayout } from './components/TillLayout';
import { Toasts } from './components/Toasts';
import { LoginPage } from './features/auth/LoginPage';
import { ChangePasswordPage } from './features/auth/ChangePasswordPage';
import { CheckoutPage } from './features/checkout/CheckoutPage';
import { queryClient } from './hooks/useTillData';
import { useSession } from './store/session';

// Everything except the till and the sign-in is fetched when it is first opened, so the till starts fast. (They are all
// saved for offline use by the service worker the first time the app loads.)
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const UsersPage = page(() => import('./features/users/UsersPage'), 'UsersPage');
const AccountsPage = page(() => import('./features/customers/AccountsPage'), 'AccountsPage');
const BackupsPage = page(() => import('./features/backups/BackupsPage'), 'BackupsPage');
const RatePage = page(() => import('./features/settings/RatePage'), 'RatePage');
const SettingsPage = page(() => import('./features/settings/SettingsPage'), 'SettingsPage');
const CashPage = page(() => import('./features/register/CashPage'), 'CashPage');
const CloseRegisterPage = page(() => import('./features/register/CloseRegisterPage'), 'CloseRegisterPage');
const ExpensesPage = page(() => import('./features/expenses/ExpensesPage'), 'ExpensesPage');
const BarcodesPage = page(() => import('./features/products/BarcodesPage'), 'BarcodesPage');
const ListsPage = page(() => import('./features/products/ListsPage'), 'ListsPage');
const DashboardPage = page(() => import('./features/reports/DashboardPage'), 'DashboardPage');
const ReportsPage = page(() => import('./features/reports/ReportsPage'), 'ReportsPage');
const ProductsPage = page(() => import('./features/products/ProductsPage'), 'ProductsPage');
const PurchasesPage = page(() => import('./features/purchases/PurchasesPage'), 'PurchasesPage');
const ReturnsPage = page(() => import('./features/returns/ReturnsPage'), 'ReturnsPage');
const SalesPage = page(() => import('./features/sales/SalesPage'), 'SalesPage');
const ServicesPage = page(() => import('./features/services/ServicesPage'), 'ServicesPage');
const LowStockPage = page(() => import('./features/stock/LowStockPage'), 'LowStockPage');
const StocktakePage = page(() => import('./features/stock/StocktakePage'), 'StocktakePage');
const StocktakeCountPage = page(() => import('./features/stock/StocktakeCountPage'), 'StocktakeCountPage');

function Protected() {
  const status = useSession((s) => s.status);
  const mustReset = useSession((s) => s.user?.mustResetPassword === true);
  if (status === 'loading') return <main className="page muted">Loading…</main>;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  // The admin gave this person a first password: they choose their own before anything else.
  if (mustReset) return <ChangePasswordPage forced />;
  return <TillLayout />;
}

/** Pages only the admin account may use (backups). The server enforces it too. */
function AdminOnly() {
  const role = useSession((s) => s.user?.role);
  return role === 'admin' ? <Outlet /> : <Navigate to="/" replace />;
}

/** Back-office pages. The server enforces the role; this only keeps a cashier from landing on a page full of errors. */
function ManagerOnly() {
  const role = useSession((s) => s.user?.role);
  return role === 'manager' || role === 'admin' ? <Outlet /> : <Navigate to="/" replace />;
}

export function App() {
  const bootstrap = useSession((s) => s.bootstrap);
  useEffect(() => void bootstrap(), [bootstrap]);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<Protected />}>
            <Route path="/" element={<CheckoutPage />} />
            <Route path="/sales" element={<SalesPage />} />
            <Route path="/returns" element={<ReturnsPage />} />
            <Route path="/password" element={<ChangePasswordPage />} />
            <Route path="/customers" element={<AccountsPage />} />
            <Route path="/low-stock" element={<LowStockPage />} />
            <Route path="/register/close" element={<CloseRegisterPage />} />
            <Route element={<AdminOnly />}>
              <Route path="/users" element={<UsersPage />} />
              <Route path="/backups" element={<BackupsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/rate" element={<RatePage />} />
            </Route>
            <Route element={<ManagerOnly />}>
              <Route path="/products" element={<ProductsPage />} />
              <Route path="/products/lists" element={<ListsPage />} />
              <Route path="/barcodes" element={<BarcodesPage />} />
              <Route path="/purchases" element={<PurchasesPage />} />
              <Route path="/stocktake" element={<StocktakePage />} />
              <Route path="/stocktake/:id" element={<StocktakeCountPage />} />
              <Route path="/expenses" element={<ExpensesPage />} />
              <Route path="/services" element={<ServicesPage />} />
              <Route path="/cash" element={<CashPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/reports" element={<ReportsPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toasts />
    </QueryClientProvider>
  );
}
