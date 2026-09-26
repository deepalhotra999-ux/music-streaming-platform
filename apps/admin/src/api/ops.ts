// Admin V2 — operations center endpoints (GET /v1/admin/*).
//
// Every value comes from the server; the client displays numbers verbatim
// and never invents metrics. Mutations are called only after an explicit
// confirmation gate (see components/ReasonDialog).

import type { ApiClient } from './client';
import type {
  AdminSession,
  ArtistAdminDetail,
  BulkTrackResult,
  CommandCenter,
  FeatureFlag,
  FinanceCommerce,
  FinanceRoyalties,
  FinanceSubscriptions,
  GlobalSearchResult,
  ImpersonationSession,
  JobsOverview,
  ModerationOverview,
  MyPermissions,
  PlatformSetting,
  SecurityOverview,
  SystemHealth,
  TimelineItem,
  WebhooksOverview,
} from './types';

export function getMyPermissions(client: ApiClient): Promise<MyPermissions> {
  return client.get<MyPermissions>('/v1/admin/me/permissions');
}

export function getCommandCenter(client: ApiClient): Promise<CommandCenter> {
  return client.get<CommandCenter>('/v1/admin/command-center');
}

export function globalSearch(client: ApiClient, q: string): Promise<GlobalSearchResult> {
  return client.get<GlobalSearchResult>(`/v1/admin/search?q=${encodeURIComponent(q)}`);
}

export function getTimeline(client: ApiClient, limit = 25): Promise<TimelineItem[]> {
  return client.get<TimelineItem[]>(`/v1/admin/timeline?limit=${limit}`);
}

// -- Artist control -----------------------------------------------------------

export function getArtistAdminDetail(client: ApiClient, id: string): Promise<ArtistAdminDetail> {
  return client.get<ArtistAdminDetail>(`/v1/admin/artists/${id}/detail`);
}

export async function suspendArtist(client: ApiClient, id: string, reason: string): Promise<void> {
  await client.post<unknown>(`/v1/admin/artists/${id}/suspend`, { reason });
}

export async function restoreArtist(client: ApiClient, id: string): Promise<void> {
  await client.post<unknown>(`/v1/admin/artists/${id}/restore`);
}

// -- Bulk content actions -----------------------------------------------------

export function bulkTrackStatus(
  client: ApiClient,
  ids: string[],
  status: 'READY' | 'TAKEDOWN',
  reason: string,
): Promise<BulkTrackResult> {
  return client.post<BulkTrackResult>('/v1/admin/tracks/bulk-status', { ids, status, reason });
}

// -- Security center ----------------------------------------------------------

export function getSecurityOverview(client: ApiClient): Promise<SecurityOverview> {
  return client.get<SecurityOverview>('/v1/admin/security/overview');
}

export function listActiveSessions(
  client: ApiClient,
  query?: { userId?: string; take?: number },
): Promise<AdminSession[]> {
  const params = new URLSearchParams();
  if (query?.userId) params.set('userId', query.userId);
  if (query?.take) params.set('take', String(query.take));
  const qs = params.toString();
  return client.get<AdminSession[]>(`/v1/admin/security/sessions${qs ? `?${qs}` : ''}`);
}

export async function revokeActiveSession(client: ApiClient, id: string): Promise<void> {
  await client.post<unknown>(`/v1/admin/security/sessions/${id}/revoke`);
}

// -- Operations visibility ----------------------------------------------------

export function getJobsOverview(client: ApiClient): Promise<JobsOverview> {
  return client.get<JobsOverview>('/v1/admin/jobs');
}

export function getWebhooksOverview(client: ApiClient): Promise<WebhooksOverview> {
  return client.get<WebhooksOverview>('/v1/admin/webhooks');
}

export function getSystemHealth(client: ApiClient): Promise<SystemHealth> {
  return client.get<SystemHealth>('/v1/admin/health');
}

// -- Finance centers ----------------------------------------------------------

export function getFinanceSubscriptions(client: ApiClient): Promise<FinanceSubscriptions> {
  return client.get<FinanceSubscriptions>('/v1/admin/finance/subscriptions');
}

export function getFinanceCommerce(client: ApiClient): Promise<FinanceCommerce> {
  return client.get<FinanceCommerce>('/v1/admin/finance/commerce');
}

export function getFinanceRoyalties(client: ApiClient): Promise<FinanceRoyalties> {
  return client.get<FinanceRoyalties>('/v1/admin/finance/royalties');
}

export function getModerationOverview(client: ApiClient): Promise<ModerationOverview> {
  return client.get<ModerationOverview>('/v1/admin/moderation/overview');
}

// -- Feature flags (SUPER_ADMIN only) ------------------------------------------

export function listFlags(client: ApiClient): Promise<FeatureFlag[]> {
  return client.get<FeatureFlag[]>('/v1/admin/flags');
}

export interface FlagInput {
  enabled: boolean;
  rolloutPercent: number;
  description?: string;
}

export async function setFlag(client: ApiClient, key: string, input: FlagInput): Promise<void> {
  await client.put<unknown>(`/v1/admin/flags/${encodeURIComponent(key)}`, input);
}

export async function deleteFlag(client: ApiClient, key: string): Promise<void> {
  await client.delete<unknown>(`/v1/admin/flags/${encodeURIComponent(key)}`);
}

// -- Platform settings (SUPER_ADMIN only) -------------------------------------

export function listSettings(client: ApiClient): Promise<PlatformSetting[]> {
  return client.get<PlatformSetting[]>('/v1/admin/settings');
}

export async function setSetting(client: ApiClient, key: string, value: unknown): Promise<void> {
  await client.put<unknown>(`/v1/admin/settings/${encodeURIComponent(key)}`, { value });
}

// -- Impersonation (SUPER_ADMIN only) ------------------------------------------

export interface ImpersonationInput {
  targetUserId: string;
  reason: string;
  durationMinutes?: number;
}

export function startImpersonation(
  client: ApiClient,
  input: ImpersonationInput,
): Promise<ImpersonationSession> {
  return client.post<ImpersonationSession>('/v1/admin/impersonation/start', input);
}

export async function endImpersonation(client: ApiClient): Promise<void> {
  await client.post<unknown>('/v1/admin/impersonation/end');
}
