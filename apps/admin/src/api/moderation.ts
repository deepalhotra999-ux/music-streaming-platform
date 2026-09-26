// Phase 17 — moderation report endpoints. All ADMIN-guarded server-side.

import type { ApiClient } from './client';
import type {
  CommunityComment,
  CommunityPost,
  ModerationReport,
  ModerationStatus,
  ModerationTargetType,
  Page,
} from './types';

export interface ModerationReportQuery {
  page?: number;
  limit?: number;
  status?: ModerationStatus;
  targetType?: ModerationTargetType;
  targetId?: string;
}

export function listModerationReports(
  client: ApiClient,
  query: ModerationReportQuery = {},
): Promise<Page<ModerationReport>> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.status) params.set('status', query.status);
  if (query.targetType) params.set('targetType', query.targetType);
  if (query.targetId) params.set('targetId', query.targetId);
  const qs = params.toString();
  return client.get<Page<ModerationReport>>(`/v1/admin/moderation-reports${qs ? `?${qs}` : ''}`);
}

export function getModerationReport(client: ApiClient, id: string): Promise<ModerationReport> {
  return client.get<ModerationReport>(`/v1/admin/moderation-reports/${id}`);
}

export interface CreateModerationReportInput {
  targetType: ModerationTargetType;
  targetId: string;
  reason: string;
  details?: string;
}

/** Files a moderation report. Callers must confirm the target first. */
export function createModerationReport(
  client: ApiClient,
  input: CreateModerationReportInput,
): Promise<ModerationReport> {
  return client.post<ModerationReport>('/v1/admin/moderation-reports', input);
}

export interface UpdateModerationReportInput {
  status?: ModerationStatus;
  reason?: string;
  details?: string | null;
}

/**
 * Updates a report: status transition and/or reason/details edits.
 * Status moves are account-impacting — callers must confirm first.
 */
export function updateModerationReport(
  client: ApiClient,
  id: string,
  input: UpdateModerationReportInput,
): Promise<ModerationReport> {
  return client.patch<ModerationReport>(`/v1/admin/moderation-reports/${id}`, input);
}

/* ------------------------------------------------------------------ */
/* Phase 29 — community content review. The same moderation queue shows */
/* reports against artist posts and comments; these helpers let admins  */
/* review the reported content (in any status) and remove or restore    */
/* it. Every action writes an immutable audit row server-side.          */
/* ------------------------------------------------------------------- */

/** Returns an artist post regardless of moderation state (ADMIN-only). */
export function getCommunityPost(client: ApiClient, id: string): Promise<CommunityPost> {
  return client.get<CommunityPost>(`/v1/admin/community/posts/${id}`);
}

/** Returns a post comment regardless of moderation state (ADMIN-only). */
export function getCommunityComment(client: ApiClient, id: string): Promise<CommunityComment> {
  return client.get<CommunityComment>(`/v1/admin/community/comments/${id}`);
}

/** Removes an artist post: ACTIVE|DELETED → REMOVED. Idempotent. */
export function moderateCommunityPost(client: ApiClient, id: string): Promise<CommunityPost> {
  return client.post<CommunityPost>(`/v1/admin/community/posts/${id}/moderate`);
}

/** Restores a moderated post: REMOVED|DELETED → ACTIVE. Idempotent. */
export function restoreCommunityPost(client: ApiClient, id: string): Promise<CommunityPost> {
  return client.post<CommunityPost>(`/v1/admin/community/posts/${id}/restore`);
}

/** Removes a comment: ACTIVE|DELETED → REMOVED. Idempotent. */
export function moderateCommunityComment(client: ApiClient, id: string): Promise<CommunityComment> {
  return client.post<CommunityComment>(`/v1/admin/community/comments/${id}/moderate`);
}

/** Restores a moderated comment: REMOVED|DELETED → ACTIVE. Idempotent. */
export function restoreCommunityComment(client: ApiClient, id: string): Promise<CommunityComment> {
  return client.post<CommunityComment>(`/v1/admin/community/comments/${id}/restore`);
}
