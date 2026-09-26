// Phase 16 — public surface of the API layer.
export { ApiClient, ApiError, apiErrorMessage } from './client';
export type { ApiClientOptions, HttpMethod, RequestOptions } from './client';
export type * from './types';
export * as authApi from './auth';
export * as usersApi from './users';
export * as artistsApi from './artists';
export * as catalogApi from './catalog';
export * as analyticsApi from './analytics';
export * as auditApi from './audit';
export * as moderationApi from './moderation';
export * as commerceApi from './commerce';
export * as releasesApi from './releases';
// Admin V2 — operations center + governance endpoints.
export * as opsApi from './ops';
export * as governanceApi from './governance';
