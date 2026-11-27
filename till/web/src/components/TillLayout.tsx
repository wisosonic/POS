import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { setShopTitle } from '../lib/shopTitle';
import { SwitchCashierDialog } from '../features/auth/SwitchCashierDialog';
import { HoldsDialog } from '../features/checkout/HoldsDialog';
import { OpenRegisterDialog } from '../features/register/OpenRegisterDialog';
import { isNotATill, useAlerts, useDeviceToken, useHolds, useRate, useRegister, useSettings, useTerminal } from '../hooks/useTillData';
import { DeviceNotATill } from '../features/terminals/DeviceNotATill';
import { StockBranchPage } from '../features/stock/StockBranchPage';
import { useLiveUpdates } from '../hooks/useLiveUpdates';
import { get } from '../lib/api';
import type { BackupStatus } from '../lib/types';
import { useConnection, startConnectionWatch } from '../store/connection';
import { REASON_TEXT } from '../lib/link';
import { startLinkWatch, useLink } from '../store/link';
import { useSession } from '../store/session';
import { useUi } from '../store/ui';
import { tNow, useT } from '../store/lang';
import { toast } from '../store/toast';
import { LanguageSwitch } from './LanguageSwitch';
import { Drawer } from './Drawer';
import { Dropdown } from './Dropdown';
import { Icon } from './Icon';

const ROLE_NAME = { cashier: 'Cashier', manager: 'Manager', admin: 'Admin' } as const;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

/** Header (menu, status, settings, account) and the register gate: nothing is sold until a register is open. */
export function TillLayout() {
  const t = useT();
  const queryClient = useQueryClient();
  const user = useSession((s) => s.user)!;
  const logout = useSession((s) => s.logout);
  const settings = useSettings();
  useRate(); // not shown in the header any more, but fetched now so the till is ready the moment it opens
  const register = useRegister();
  const terminal = useTerminal();
  useLiveUpdates(); // prices, stock, rate and registers stay current without waiting for a reload
  const deviceToken = useDeviceToken();
  const holds = useHolds();
  const alerts = useAlerts();
  const { online, waiting, blocked } = useConnection();
  const stopped = useLink((s) => s.block); // the branch server is not answering: selling is stopped (docs/14)
  const holdsOpen = useUi((s) => s.holdsOpen);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const location = useLocation();

  useEffect(() => setMenuOpen(false), [location.pathname]);

  useEffect(() => startLinkWatch(), []); // the heartbeat's answer, asked of the till's own server every 2 seconds

  // Bring the catalog up to date, and keep trying to send any sale that could not reach the server.
  useEffect(() => {
    void useUi.getState().loadCatalog();
    return startConnectionWatch(() => {
      toast.success(tNow('The sale was confirmed by the server. Selling can continue.'));
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
    <Suspense fallback={<main className="page muted">{t('Loading…')}</main>}>
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
          aria-label={t('Menu')}
          onClick={() => setMenuOpen(true)}
        >
          <Icon name="menu" size={19} />
        </button>
        <Link className="brand" to="/">
          {shopName}
        </Link>

        <div className="header-status">
          {terminal.data && deviceToken && (
            <span className="chip hide-small" data-testid="till-name">
              <Icon name="till" size={15} />
              {terminal.data.name}
            </span>
          )}
          {register.data && (
            <span className="chip hide-small">
              <Icon name="register" size={15} />
              {t('Register #{n} · {name}', { n: register.data.id, name: user.name })}
            </span>
          )}
          {backupOverdue &&
            (isAdmin ? (
              <Link className="chip danger" to="/settings/backups" data-testid="backup-overdue">
                <Icon name="backups" size={15} />
                {t('Backup overdue')}
              </Link>
            ) : (
              <span className="chip danger" data-testid="backup-overdue" title={t('Tell the owner: the last backup is too old')}>
                <Icon name="backups" size={15} />
                {t('Backup overdue')}
              </span>
            ))}
        </div>

        <span className="spacer" />

        <div className="header-right">
          {holdCount > 0 && (
            <button className="btn small" onClick={() => useUi.getState().setHoldsOpen(true)}>
              <Icon name="hold" size={16} />
              {t('Holds ({n})', { n: holdCount })}
            </button>
          )}
          {lowCount > 0 && (
            <Link
              className="chip warn"
              to="/low-stock"
              title={t('{n} products are running low', { n: lowCount })}
              aria-label={t('{n} products are running low', { n: lowCount })}
            >
              <Icon name="lowstock" size={15} />
              {lowCount}
            </Link>
          )}
          {waiting > 0 && (
            <Link className="chip warn" to="/sales" title={t('Sales waiting to be sent')}>
              {t('{n} pending', { n: waiting })}
            </Link>
          )}
          {blocked > 0 && (
            <Link className="chip danger" to="/sales" title={t('Sales the server refused')}>
              {t('{n} need attention', { n: blocked })}
            </Link>
          )}
          <span className={`chip ${online ? 'ok' : 'danger'}`}>
            <Icon name={online ? 'wifi' : 'wifioff'} size={15} />
            {online ? t('Online') : t('Offline')}
          </span>

          <LanguageSwitch />

          <NavLink
            to="/settings"
            className={({ isActive }) => `icon-btn${isActive ? ' on' : ''}`}
            aria-label={t('Settings')}
            title={t('Settings')}
          >
            <Icon name="settings" size={22} />
          </NavLink>

          <Dropdown
            label={t('Account: {name}', { name: user.name })}
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
                    <div className="muted dropdown-sub">{`${user.username} · ${t(ROLE_NAME[user.role])}`}</div>
                  </div>
                </div>
                <Link to="/password" className="dropdown-item" onClick={close}>
                  <Icon name="key" />
                  {t('Change my password')}
                </Link>
                <button
                  className="dropdown-item"
                  onClick={() => {
                    close();
                    setSwitching(true);
                  }}
                >
                  <Icon name="switch" />
                  {t('Switch cashier')}
                </button>
                <button className="dropdown-item danger" onClick={() => void logout()}>
                  <Icon name="logout" />
                  {t('Sign out ({name})', { name: user.name })}
                </button>
              </>
            )}
          </Dropdown>
        </div>
      </header>

      {stopped && (
        <div className="banner warn" role="alert" data-testid="selling-stopped" style={{ margin: '8px 12px 0' }}>
          <div className="title">
            {stopped.cause === 'branch'
              ? t('The branch server is not answering. Selling is stopped until it is back.')
              : t('The till program on this PC is not answering. Selling is stopped until it is back.')}
          </div>
          <div className="muted">
            {t('Your cart is kept. This screen checks again every few seconds and starts again by itself.')}
            {stopped.reason && REASON_TEXT[stopped.reason] ? ` ${t(REASON_TEXT[stopped.reason]!)}` : ''}
          </div>
        </div>
      )}

      {waiting + blocked > 0 && (
        <div className="banner warn" role="alert" data-testid="sale-in-doubt" style={{ margin: '8px 12px 0' }}>
          <div className="title">
            {waiting > 0
              ? t('A sale is not confirmed yet. Do not ring it up again: selling resumes when the server confirms it.')
              : t('The server refused a sale. Selling resumes when someone has dealt with it.')}
          </div>
          <div className="buttons">
            <span className="muted">
              {waiting > 0 ? t('It is sent again by itself with the same number, so it cannot be recorded twice.') : ''}
            </span>
            <Link className="btn small" to="/sales">
              {t('See it')}
            </Link>
          </div>
        </div>
      )}

      {!needsRegister ? (
        outlet
      ) : settings.data?.branchKind === 'stock' ? (
        <StockBranchPage />
      ) : isNotATill(register.error) || isNotATill(terminal.error) ? (
        <DeviceNotATill />
      ) : register.isLoading ? (
        <main className="page muted">{t('Loading…')}</main>
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
