import { NavLink, Outlet } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { atLeast, SETTINGS_NAV } from '../../lib/nav';
import { useSession } from '../../store/session';

/** The Settings page: a side menu on the left (a list across the top on a narrow screen) and the chosen section beside it. */
export function SettingsLayout() {
  const role = useSession((s) => s.user?.role) ?? 'cashier';
  const items = SETTINGS_NAV.filter((i) => atLeast(role, i.min));
  return (
    <div className="settings-layout">
      <aside className="settings-menu">
        <h2>Settings</h2>
        <nav aria-label="Settings">
          {items.map((i) => (
            <NavLink key={i.to} to={i.to} className={({ isActive }) => `nav-link${isActive ? ' on' : ''}`}>
              <Icon name={i.icon} />
              <span>{i.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="settings-content">
        <Outlet />
      </div>
    </div>
  );
}
