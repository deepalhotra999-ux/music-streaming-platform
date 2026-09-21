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
