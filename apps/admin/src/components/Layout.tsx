// Phase 16 — protected layout: sidebar nav + header with admin identity.
// Admin V2 — permission-aware nav: sections render only when the caller's
// effective permission set includes the section's gate key. The server
// re-checks every endpoint; this only shapes the UX.

import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/PermissionsContext';
import type { PermissionKey } from '../api/types';
import { ImpersonationBanner } from './ImpersonationBanner';

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  /** Section is visible when the caller holds at least one of these. Empty = always visible to admins. */
  anyOf?: PermissionKey[];
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Command Center', end: true },
  { to: '/search', label: 'Search' },
  { to: '/users', label: 'Users', anyOf: ['users.view'] },
  { to: '/roles', label: 'Roles', anyOf: ['roles.manage'] },
  { to: '/artists', label: 'Artists', anyOf: ['users.view', 'content.moderate'] },
  { to: '/catalog', label: 'Catalog', anyOf: ['content.moderate'] },
  { to: '/moderation', label: 'Moderation', anyOf: ['reports.moderate', 'content.moderate'] },
  { to: '/finance', label: 'Finance', anyOf: ['finance.view'] },
  { to: '/commerce', label: 'Commerce', anyOf: ['commerce.manage'] },
  { to: '/security', label: 'Security', anyOf: ['security.view'] },
  { to: '/ops', label: 'Operations', anyOf: ['jobs.view', 'webhooks.view', 'system.view'] },
  { to: '/analytics', label: 'Analytics', anyOf: ['system.view'] },
  { to: '/releases', label: 'Releases', anyOf: ['system.view'] },
  { to: '/config', label: 'Platform Config', anyOf: ['flags.manage', 'settings.manage'] },
  { to: '/impersonate', label: 'Impersonate', anyOf: ['users.impersonate'] },
  { to: '/audit', label: 'Audit Log', anyOf: ['audit.view'] },
];

export function AdminLayout(): React.ReactNode {
  const { user, logout } = useAuth();
  const { can, isLoading: permissionsLoading } = usePermissions();

  const visibleItems = NAV_ITEMS.filter(
    (item) => !item.anyOf || item.anyOf.some((key) => can(key)),
  );

  return (
    <div className="app-shell">
      {/* Phase 31 — skip link for keyboard users. */}
      <a href="#admin-main-content" className="skip-link">
        Skip to main content
      </a>
      <aside className="sidebar" aria-label="Admin">
        <div className="brand">Waveform Admin</div>
        <nav aria-label="Admin sections">
          {permissionsLoading ? (
            <p className="muted" style={{ fontSize: 13 }}>
              Loading sections…
            </p>
          ) : (
            <ul>
              {visibleItems.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
        </nav>
      </aside>
      <div className="main">
        <ImpersonationBanner />
        <header className="topbar">
          <div className="topbar-identity">
            <span className="muted">Signed in as</span> <strong>{user?.displayName}</strong>{' '}
            <span className="badge badge-red">{user?.role}</span>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              void logout();
            }}
          >
            Log out
          </button>
        </header>
        <main className="content" id="admin-main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
