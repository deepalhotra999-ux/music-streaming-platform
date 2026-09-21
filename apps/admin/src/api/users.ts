// Phase 16 — admin user-management endpoints. ADMIN-guarded server-side.

import type { ApiClient } from './client';
import type { AdminUser, AdminUserDetail, Page, UserRole } from './types';

export interface UserListQuery {
  q?: string;
  role?: UserRole;
  page?: number;
  limit?: number;
  /** Phase 17 — include soft-deleted accounts in the listing. */
  includeDeleted?: boolean;
}

export function listUsers(client: ApiClient, query: UserListQuery = {}): Promise<Page<AdminUser>> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.role) params.set('role', query.role);
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.includeDeleted) params.set('includeDeleted', 'true');
  const qs = params.toString();
  return client.get<Page<AdminUser>>(`/v1/users${qs ? `?${qs}` : ''}`);
}

export function getUser(client: ApiClient, id: string): Promise<AdminUser> {
  return client.get<AdminUser>(`/v1/users/${id}`);
}

/** Phase 17 — full admin user detail: account status + owned artists. */
export function getAdminUserDetail(client: ApiClient, id: string): Promise<AdminUserDetail> {
  return client.get<AdminUserDetail>(`/v1/admin/users/${id}`);
}

/** Changes a user's role. Destructive-ish: callers must confirm first. */
export function updateUserRole(client: ApiClient, id: string, role: UserRole): Promise<AdminUser> {
  return client.patch<AdminUser>(`/v1/users/${id}/role`, { role });
}
