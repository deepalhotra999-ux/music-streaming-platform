// Phase 16 — admin artist endpoints. ADMIN-guarded server-side.

import type { ApiClient } from './client';
import type { ArtistDetail, ArtistListItem, Page } from './types';

export interface ArtistListQuery {
  q?: string;
  /** Tri-state: true | false | undefined (all). */
  verified?: boolean;
  page?: number;
  limit?: number;
}

export function listArtists(
  client: ApiClient,
  query: ArtistListQuery = {},
): Promise<Page<ArtistListItem>> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.verified !== undefined) params.set('verified', String(query.verified));
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return client.get<Page<ArtistListItem>>(`/v1/artists${qs ? `?${qs}` : ''}`);
}

export function getArtist(client: ApiClient, id: string): Promise<ArtistDetail> {
  return client.get<ArtistDetail>(`/v1/artists/${id}`);
}

/**
 * Verify or unverify an artist. The body carries only `{ verified }`, which
 * the backend accepts (minProperties: 1). Callers must confirm first.
 */
export function setArtistVerified(
  client: ApiClient,
  id: string,
  verified: boolean,
): Promise<ArtistDetail> {
  return client.patch<ArtistDetail>(`/v1/artists/${id}`, { verified });
}

/** Deletes an artist. Callers must confirm first. */
export function deleteArtist(client: ApiClient, id: string): Promise<unknown> {
  return client.delete<unknown>(`/v1/artists/${id}`);
}
