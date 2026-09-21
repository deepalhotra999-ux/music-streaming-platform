// Phase 16 — admin webapp routing.
//
// /login is public. Everything else sits behind RequireAdmin (ADMIN-only UX;
// the server enforces roles on every admin endpoint).

import { HashRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAdmin } from './auth/AuthContext';
import { AdminLayout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { UsersPage } from './pages/UsersPage';
import { ArtistsPage } from './pages/ArtistsPage';
import { CatalogPage } from './pages/CatalogPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { AuditLogPage } from './pages/AuditLogPage';

export function App(): React.ReactNode {
  return (
    <AuthProvider>
      <HashRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/*"
            element={
              <RequireAdmin>
                <AdminLayout />
              </RequireAdmin>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="artists" element={<ArtistsPage />} />
            <Route path="catalog" element={<CatalogPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="audit" element={<AuditLogPage />} />
          </Route>
        </Routes>
      </HashRouter>
    </AuthProvider>
  );
}
