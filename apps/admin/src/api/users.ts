// Phase 16 — admin user-management endpoints. ADMIN-guarded server-side.

import type { ApiClient } from './client';
import type { AdminUser, Page, UserRole } from './types';

export interface UserListQuery {
  q?: string;
  role?: UserRole;
  page?: number;
  limit?: number;
}

export function listUsers(client: ApiClient, query: UserListQuery = {}): Promise<Page<AdminUser>> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.role) params.set('role', query.role);
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return client.get<Page<AdminUser>>(`/v1/users${qs ? `?${qs}` : ''}`);
}

export function getUser(client: ApiClient, id: string): Promise<AdminUser> {
  return client.get<AdminUser>(`/v1/users/${id}`);
}

/** Changes a user's role. Destructive-ish: callers must confirm first. */
export function updateUserRole(client: ApiClient, id: string, role: UserRole): Promise<AdminUser> {
  return client.patch<AdminUser>(`/v1/users/${id}/role`, { role });
}
