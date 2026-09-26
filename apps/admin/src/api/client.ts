// Phase 16 — reusable HTTP client for the admin webapp.
//
// Mirrors the mobile ApiClient pattern adapted to the browser:
// - JSON request/response handling with typed results.
// - `Authorization: Bearer <token>` injection via a caller-supplied getter
//   (the client never owns token storage; see src/auth/AuthContext.tsx).
// - Single transparent retry: on 401 the caller-supplied refresh callback
//   runs once; the original request is retried with the new token.
// - RFC 7807 problem bodies are surfaced as ApiError with status/title/
//   detail/field errors intact, so pages can render precise messages.

import type { ProblemDetail } from './types';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  /** JSON-serializable body. */
  body?: unknown;
  /** Attach `Authorization: Bearer <token>` (default true). */
  auth?: boolean;
  /** @internal Set after a 401 refresh retry so it happens at most once. */
  _retried?: boolean;
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Returns the current access token, or null when signed out. */
  getAccessToken?: () => string | null;
  /**
   * Called at most once per request when an authenticated call gets a 401.
   * Should rotate the token pair and return the new access token, or null
   * when the session cannot be refreshed (caller then signs out).
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

  get isForbidden(): boolean {
    return this.status === 403;
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

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly getAccessToken: () => string | null;
  private readonly onTokenRefresh?: () => Promise<string | null>;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    // NOTE: the default fetch must be wrapped so it is always invoked as a
    // bare call. Storing the raw global and calling it as `this.fetchFn()`
    // rebinds `this` to the ApiClient instance, and strict implementations
    // (Firefox) reject the call with "Illegal invocation" before any
    // network traffic happens.
    this.fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.getAccessToken = options.getAccessToken ?? (() => null);
    this.onTokenRefresh = options.onTokenRefresh;
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, { ...options, body });
  }

  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, { ...options, body });
  }

  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, { ...options, body });
  }

  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const useAuth = options.auth !== false;
    const token = useAuth ? this.getAccessToken() : null;
    const response = await this.send(method, path, options, token);

    if (response.status === 401 && useAuth && this.onTokenRefresh && !options._retried) {
      const newToken = await this.onTokenRefresh();
      if (newToken) {
        const retried = await this.send(method, path, { ...options, _retried: true }, newToken);
        return this.parse<T>(retried);
      }
    }
    return this.parse<T>(response);
  }

  private async send(
    method: HttpMethod,
    path: string,
    options: RequestOptions,
    token: string | null,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    // Only send a JSON content type when there is a JSON body: Fastify
    // rejects empty bodies declared as application/json with 400.
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body,
      });
    } catch (cause) {
      throw new ApiError(0, undefined, cause);
    }
    return response;
  }

  private async parse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json') || contentType.includes('problem+json');
    let payload: unknown = null;
    if (isJson) {
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
    } else {
      await response.text().catch(() => null);
    }

    if (response.ok) {
      return payload as T;
    }
    const problem =
      payload !== null && typeof payload === 'object'
        ? (payload as Partial<ProblemDetail>)
        : undefined;
    throw new ApiError(response.status, problem);
  }
}
