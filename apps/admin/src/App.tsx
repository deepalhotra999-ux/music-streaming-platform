// Phase 16 — admin webapp routing.
//
// /login is public. Everything else sits behind RequireAdmin (UX-only; the
// server enforces roles on every admin endpoint). Admin V2 adds the
// PermissionsProvider so the shell can gate nav sections on the caller's
// effective permission set.

import { HashRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAdmin } from './auth/AuthContext';
import { PermissionsProvider } from './auth/PermissionsContext';
import { AdminLayout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { CommandCenterPage } from './pages/CommandCenterPage';
import { SearchPage } from './pages/SearchPage';
import { UsersPage } from './pages/UsersPage';
import { RolesPage } from './pages/RolesPage';
import { ArtistsPage } from './pages/ArtistsPage';
import { CatalogPage } from './pages/CatalogPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { ModerationPage } from './pages/ModerationPage';
import { CommercePage } from './pages/CommercePage';
import { FinancePage } from './pages/FinancePage';
import { SecurityPage } from './pages/SecurityPage';
import { OpsPage } from './pages/OpsPage';
import { PlatformConfigPage } from './pages/PlatformConfigPage';
import { ImpersonationPage } from './pages/ImpersonationPage';
import { ReleasesPage } from './pages/ReleasesPage';

export function App(): React.ReactNode {
  return (
    <AuthProvider>
      <PermissionsProvider>
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
              <Route index element={<CommandCenterPage />} />
              <Route path="search" element={<SearchPage />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="roles" element={<RolesPage />} />
              <Route path="artists" element={<ArtistsPage />} />
              <Route path="catalog" element={<CatalogPage />} />
              <Route path="analytics" element={<AnalyticsPage />} />
              <Route path="moderation" element={<ModerationPage />} />
              <Route path="commerce" element={<CommercePage />} />
              <Route path="finance" element={<FinancePage />} />
              <Route path="security" element={<SecurityPage />} />
              <Route path="ops" element={<OpsPage />} />
              <Route path="config" element={<PlatformConfigPage />} />
              <Route path="impersonate" element={<ImpersonationPage />} />
              <Route path="releases" element={<ReleasesPage />} />
              <Route path="audit" element={<AuditLogPage />} />
            </Route>
          </Routes>
        </HashRouter>
      </PermissionsProvider>
    </AuthProvider>
  );
}
