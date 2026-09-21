// Phase 16 — shared test harness: stubbed global fetch, token seeding,
// and an AuthProvider-backed render.

import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { AuthProvider } from '../auth/AuthContext';
import type { AdminUser } from '../api/types';

export const ACCESS_KEY = 'waveform.admin.accessToken';
export const REFRESH_KEY = 'waveform.admin.refreshToken';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function problemResponse(status: number, title: string, detail?: string): Response {
  return jsonResponse({ type: 'about:blank', title, status, detail }, status);
}

export type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Replaces global fetch with a stub; returns the mock for assertions. */
export function stubFetch(handler: FetchHandler): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => handler(String(url), init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

export function adminUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 'admin-0001',
    email: 'admin@example.com',
    displayName: 'Ada Admin',
    avatarUrl: null,
    role: 'ADMIN',
    emailVerified: true,
    countryCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

/** Seeds stored tokens and renders inside MemoryRouter + AuthProvider. */
export function renderWithAuth(
  ui: ReactNode,
  options: { user?: AdminUser; initialPath?: string; fetchHandler?: FetchHandler } = {},
): RenderResult & { fetchMock: ReturnType<typeof vi.fn> } {
  const user = options.user ?? adminUser();
  localStorage.setItem(ACCESS_KEY, 'stored-access');
  localStorage.setItem(REFRESH_KEY, 'stored-refresh');

  const handler: FetchHandler =
    options.fetchHandler ??
    ((url) => {
      if (url.endsWith('/v1/me')) return jsonResponse(user);
      if (url.endsWith('/v1/auth/logout')) return jsonResponse({}, 200);
      throw new Error(`unexpected fetch: ${url}`);
    });
  const fetchMock = stubFetch(handler);

  const result = render(
    <MemoryRouter initialEntries={[options.initialPath ?? '/']}>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  );
  return { ...result, fetchMock };
}

/** Renders without seeded tokens (unauthenticated). */
export function renderAnonymous(ui: ReactNode): RenderResult {
  const fetchMock = stubFetch(() => {
    throw new Error('fetch should not be called when anonymous');
  });
  void fetchMock;
  return render(
    <MemoryRouter initialEntries={['/users']}>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  );
}

export function pageEnvelope<T>(data: T[], page = 1, limit = 20, total?: number) {
  const totalCount = total ?? data.length;
  return {
    data,
    pagination: {
      page,
      limit,
      total: totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    },
  };
}
