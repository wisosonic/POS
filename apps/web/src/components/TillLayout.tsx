import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { setShopTitle } from '../lib/shopTitle';
import { SwitchCashierDialog } from '../features/auth/SwitchCashierDialog';
import { HoldsDialog } from '../features/checkout/HoldsDialog';
import { OpenRegisterDialog } from '../features/register/OpenRegisterDialog';
import { useAlerts, useHolds, useRate, useRegister, useSettings } from '../hooks/useTillData';
import { get } from '../lib/api';
import type { BackupStatus } from '../lib/types';
import { useConnection, startConnectionWatch } from '../store/connection';
import { useSession } from '../store/session';
import { useUi } from '../store/ui';
import { Drawer } from './Drawer';
import { Dropdown } from './Dropdown';
import { Icon } from './Icon';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

/** Header (menu, status, settings, account) and the register gate: nothing is sold until a register is open. */
export function TillLayout() {
  const queryClient = useQueryClient();
  const user = useSession((s) => s.user)!;
  const logout = useSession((s) => s.logout);
  const settings = useSettings();
  useRate(); // not shown in the header any more, but fetched now so the till is ready the moment it opens
  const register = useRegister();
  const holds = useHolds();
  const alerts = useAlerts();
  const { online, waiting, blocked } = useConnection();
  const holdsOpen = useUi((s) => s.holdsOpen);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const location = useLocation();

  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Bring the catalog up to date, and keep trying to send any sale that could not reach the server.
  useEffect(() => {
    void useUi.getState().loadCatalog();
    return startConnectionWatch(() => {
      void queryClient.invalidateQueries({ queryKey: ['register'] });
      void queryClient.invalidateQueries({ queryKey: ['alerts'] });
    });
  }, [queryClient]);

  const isManager = user.role === 'manager' || user.role === 'admin';
  const isAdmin = user.role === 'admin';
  // The owner has to hear about a missing backup before the day the disk fails, so managers see it in the header.
  const backup = useQuery({
    queryKey: ['backup-status'],
    enabled: isManager,
    refetchInterval: 600_000,
    queryFn: () => get<BackupStatus>('/backups/status'),
  });
  const backupOverdue = isManager && backup.data?.configured === true && backup.data.stale;
  // Selling, closing and taking returns (the refund leaves the drawer) need an open register; managing products does not.
  const needsRegister =
    location.pathname === '/' || location.pathname.startsWith('/register') || ['/returns', '/cash'].includes(location.pathname);
  const holdCount = holds.data?.length ?? 0;
  const lowCount = alerts.data?.length ?? 0;
  const shopName = settings.data?.name ?? 'Till';
  useEffect(() => setShopTitle(settings.data?.name), [settings.data?.name]); // the tab is named after the shop
  // A page that is opened for the first time is fetched now: the header stays, only the page area waits.
  const outlet = (
    <Suspense fallback={<main className="page muted">Loading…</main>}>
      <Outlet />
    </Suspense>
  );

  return (
    <div className="shell">
      <header className="header">
        <button
          className="icon-btn menu-btn"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          aria-label="Menu"
          onClick={() => setMenuOpen(true)}
        >
          <Icon name="menu" size={19} />
        </button>
        <Link className="brand" to="/">
          {shopName}
        </Link>

        <div className="header-status">
          {register.data && (
            <span className="chip hide-small">
              <Icon name="register" size={15} />
              {`Register #${register.data.id} · ${user.name}`}
            </span>
          )}
          {backupOverdue &&
            (isAdmin ? (
              <Link className="chip danger" to="/settings/backups" data-testid="backup-overdue">
                <Icon name="backups" size={15} />
                Backup overdue
              </Link>
            ) : (
              <span className="chip danger" data-testid="backup-overdue" title="Tell the owner: the last backup is too old">
                <Icon name="backups" size={15} />
                Backup overdue
              </span>
            ))}
        </div>

        <span className="spacer" />

        <div className="header-right">
          {holdCount > 0 && (
            <button className="btn small" onClick={() => useUi.getState().setHoldsOpen(true)}>
              <Icon name="hold" size={16} />
              {`Holds (${holdCount})`}
            </button>
          )}
          {lowCount > 0 && (
            <Link
              className="chip warn"
              to="/low-stock"
              title={`${lowCount} products are running low`}
              aria-label={`${lowCount} products are running low`}
            >
              <Icon name="lowstock" size={15} />
              {lowCount}
            </Link>
          )}
          {waiting > 0 && (
            <Link className="chip warn" to="/sales" title="Sales waiting to be sent">
              {waiting} pending
            </Link>
          )}
          {blocked > 0 && (
            <Link className="chip danger" to="/sales" title="Sales the server refused">
              {blocked} need attention
            </Link>
          )}
          <span className={`chip ${online ? 'ok' : 'danger'}`}>
            <Icon name={online ? 'wifi' : 'wifioff'} size={15} />
            {online ? 'Online' : 'Offline'}
          </span>

          <NavLink to="/settings" className={({ isActive }) => `icon-btn${isActive ? ' on' : ''}`} aria-label="Settings" title="Settings">
            <Icon name="settings" size={22} />
          </NavLink>

          <Dropdown
            label={`Account: ${user.name}`}
            className="account-btn"
            trigger={
              <>
                <span className="avatar" aria-hidden="true">
                  {initials(user.name)}
                </span>
                <span className="account-name hide-small">{user.name}</span>
                <Icon name="chevron" size={16} />
              </>
            }
          >
            {(close) => (
              <>
                <div className="dropdown-user">
                  <span className="avatar big" aria-hidden="true">
                    {initials(user.name)}
                  </span>
                  <div>
                    <div className="dropdown-name">{user.name}</div>
                    <div className="muted dropdown-sub">{`${user.username} · ${user.role}`}</div>
                  </div>
                </div>
                <Link to="/password" className="dropdown-item" onClick={close}>
                  <Icon name="key" />
                  Change my password
                </Link>
                <button
                  className="dropdown-item"
                  onClick={() => {
                    close();
                    setSwitching(true);
                  }}
                >
                  <Icon name="switch" />
                  Switch cashier
                </button>
                <button className="dropdown-item danger" onClick={() => void logout()}>
                  <Icon name="logout" />
                  {`Sign out (${user.name})`}
                </button>
              </>
            )}
          </Dropdown>
        </div>
      </header>

      {!needsRegister ? (
        outlet
      ) : register.isLoading ? (
        <main className="page muted">Loading…</main>
      ) : register.data === null ? (
        <OpenRegisterDialog />
      ) : (
        outlet
      )}
      {holdsOpen && <HoldsDialog />}
      {switching && <SwitchCashierDialog onClose={() => setSwitching(false)} />}
      {menuOpen && <Drawer role={user.role} shopName={shopName} onClose={() => setMenuOpen(false)} />}
    </div>
  );
}
