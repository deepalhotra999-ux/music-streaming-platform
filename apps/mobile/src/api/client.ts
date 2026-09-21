// Phase 5 — reusable HTTP client for the music API.
//
// Responsibilities:
// - JSON request/response handling with typed results.
// - Bearer token injection via a caller-supplied getter (the client never
//   owns token storage; see src/auth).
// - Single transparent retry: on 401 the caller-supplied refresh callback
//   runs once; the request is retried with the new token.
// - RFC 7807 problem bodies are surfaced as ApiError with status/title/
//   detail/field errors intact, so screens can render precise messages.
//
// Everything platform-specific (fetch, storage) is injected, which keeps
// this module unit-testable in plain Node/jest.

import type { ProblemDetail } from './types';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  /** JSON-serializable body. */
  body?: unknown;
  /** Attach `Authorization: Bearer <token>` (default true). */
  auth?: boolean;
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Returns the current access token, or null when signed out. */
  getAccessToken?: () => string | null;
  /**
   * Called once when an authenticated request gets a 401. Should rotate the
   * token pair and return the new access token, or null when the session
   * cannot be refreshed (caller then signs out).
   */
  onTokenRefresh?: () => Promise<string | null>;
}

export class ApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number;
  readonly title: string;
  readonly detail?: string;
  readonly fieldErrors: { field?: string; message: string }[];

  constructor(status: number, problem?: Partial<ProblemDetail>, cause?: unknown) {
    super(problem?.detail || problem?.title || 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.title = problem?.title ?? (status === 0 ? 'Network error' : 'Request failed');
    this.detail = problem?.detail;
    this.fieldErrors = problem?.errors ?? [];
    if (cause !== undefined) {
      // Keep the underlying fetch error for diagnostics without leaking it
      // into the user-facing message.
      (this as { cause?: unknown }).cause = cause;
    }
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

/** Human-readable message for banners/toasts. Prefers detail, then title. */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.detail || error.title || 'Something went wrong. Please try again.';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

function isProblemBody(value: unknown): value is ProblemDetail {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { title?: unknown }).title === 'string'
  );
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly getAccessToken?: () => string | null;
  private readonly onTokenRefresh?: () => Promise<string | null>;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
    this.getAccessToken = options.getAccessToken;
    this.onTokenRefresh = options.onTokenRefresh;
  }

  async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    const useAuth = options.auth ?? true;
    const token = useAuth ? this.getAccessToken?.() ?? null : null;
    try {
      const response = await this.fetchFn(this.baseUrl + path, {
        method,
        headers: this.buildHeaders(options.body !== undefined, token),
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      if (response.status === 401 && useAuth && this.onTokenRefresh) {
        // Single transparent retry with a rotated token pair.
        const refreshed = await this.onTokenRefresh().catch(() => null);
        if (refreshed) {
          const retry = await this.fetchFn(this.baseUrl + path, {
            method,
            headers: this.buildHeaders(options.body !== undefined, refreshed),
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          });
          return this.readBody<T>(retry);
        }
      }
      return this.readBody<T>(response);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(0, { title: 'Network error', detail: 'Could not reach the server. Check your connection and try again.' }, error);
    }
  }

  get<T>(path: string, options: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('POST', path, { ...options, body });
  }

  patch<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('PATCH', path, { ...options, body });
  }

  put<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('PUT', path, { ...options, body });
  }

  delete<T>(path: string, options: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  private buildHeaders(hasBody: boolean, token: string | null): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private async readBody<T>(response: Response): Promise<T> {
    if (response.status === 204) {
      return undefined as T;
    }
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new ApiError(
        response.status,
        isProblemBody(data) ? data : { title: `Request failed (${response.status})` },
      );
    }
    return data as T;
  }
}
