// Phase 16 — protected layout: sidebar nav + header with admin identity.

import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/users', label: 'Users' },
  { to: '/artists', label: 'Artists' },
  { to: '/catalog', label: 'Catalog' },
  { to: '/moderation', label: 'Moderation' },
  { to: '/commerce', label: 'Commerce' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/audit', label: 'Audit Log' },
];

export function AdminLayout(): React.ReactNode {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Waveform Admin</div>
        <nav aria-label="Admin sections">
          <ul>
            {NAV_ITEMS.map((item) => (
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
        </nav>
      </aside>
      <div className="main">
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
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
