// Phase 5 — API layer public surface.
export { getApiBaseUrl } from './config';
export { ApiClient, ApiError, apiErrorMessage } from './client';
export type { ApiClientOptions, HttpMethod, RequestOptions } from './client';
export { getMe, login, logout, refreshTokens, register } from './auth';
export type {
  AuthResult,
  FieldError,
  LoginInput,
  ProblemDetail,
  RegisterInput,
  TokenPair,
  User,
  UserRole,
} from './types';
