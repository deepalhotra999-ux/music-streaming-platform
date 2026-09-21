// Phase 5 — API contract types.
// Mirrors the backend JSON shapes (services/api/src/modules/auth/schemas.ts).
// Kept as plain interfaces so screens never depend on fetch details.

export type UserRole = 'LISTENER' | 'ARTIST' | 'ADMIN';

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: UserRole;
  emailVerified: boolean;
  countryCode: string | null;
  createdAt: string;
}

export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

export interface AuthResult {
  user: User;
  tokens: TokenPair;
}

export interface FieldError {
  field?: string;
  message: string;
}

/** RFC 7807 problem body returned by the API on errors. */
export interface ProblemDetail {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  errors?: FieldError[];
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
}

export interface LoginInput {
  email: string;
  password: string;
}
