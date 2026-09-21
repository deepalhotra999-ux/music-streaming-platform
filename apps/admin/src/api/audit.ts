// Phase 16 — audit log read endpoint. The audit trail is IMMUTABLE:
// this module exposes reads only. There are deliberately no edit or delete
// wrappers, and the UI renders no edit/delete controls.

import type { ApiClient } from './client';
import type { AuditLog, Page } from './types';

export interface AuditLogQuery {
  page?: number;
  limit?: number;
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
}

export function listAuditLogs(
  client: ApiClient,
  query: AuditLogQuery = {},
): Promise<Page<AuditLog>> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.action) params.set('action', query.action);
  if (query.actorId) params.set('actorId', query.actorId);
  if (query.targetType) params.set('targetType', query.targetType);
  if (query.targetId) params.set('targetId', query.targetId);
  const qs = params.toString();
  return client.get<Page<AuditLog>>(`/v1/admin/audit-logs${qs ? `?${qs}` : ''}`);
}
