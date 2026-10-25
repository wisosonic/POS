import { useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { atLeast, NAV } from '../lib/nav';
import type { Role } from '../lib/types';
import { useT } from '../store/lang';
import { Icon } from './Icon';

/**
 * The main menu: a panel that slides in from the side on every screen size. It is a native <dialog>, so focus stays inside it,
 * Escape closes it and the page behind cannot be used. Grouped, with an icon for each place and the current one marked.
 */
export function Drawer({ role, shopName, onClose }: { role: Role; shopName: string; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-label={t('Menu')}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // a click on the dimmed part outside the panel
      }}
    >
      <div className="drawer-body">
        <div className="drawer-head">
          <span className="brand">{shopName}</span>
          <button className="icon-btn" onClick={onClose} aria-label={t('Close the menu')}>
            <Icon name="close" />
          </button>
        </div>
        <nav aria-label={t('Menu')}>
          {NAV.map((section) => {
            const items = section.items.filter((i) => atLeast(role, i.min));
            if (items.length === 0) return null;
            return (
              <div key={section.title} className="nav-group">
                <div className="nav-title">{t(section.title)}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end className={({ isActive }) => `nav-link${isActive ? ' on' : ''}`} onClick={onClose}>
                    <Icon name={i.icon} />
                    <span>{t(i.label)}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
      </div>
    </dialog>
  );
}
