// Phase 16 — admin catalog read + supported mutation endpoints.
// Supported admin actions only: the existing PATCH/DELETE endpoints, each
// behind a ConfirmDialog in the UI. No new publishing workflows here.

import type { ApiClient } from './client';
import type {
  AlbumDetail,
  AlbumListItem,
  Page,
  TrackDetail,
  TrackListItem,
  TrackStatus,
} from './types';

export interface AlbumListQuery {
  q?: string;
  page?: number;
  limit?: number;
}

export function listAlbums(
  client: ApiClient,
  query: AlbumListQuery = {},
): Promise<Page<AlbumListItem>> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return client.get<Page<AlbumListItem>>(`/v1/albums${qs ? `?${qs}` : ''}`);
}

export function getAlbum(client: ApiClient, id: string): Promise<AlbumDetail> {
  return client.get<AlbumDetail>(`/v1/albums/${id}`);
}

/** Deletes an album (soft delete server-side). Callers must confirm first. */
export function deleteAlbum(client: ApiClient, id: string): Promise<unknown> {
  return client.delete<unknown>(`/v1/albums/${id}`);
}

export interface TrackListQuery {
  q?: string;
  status?: TrackStatus;
  page?: number;
  limit?: number;
}

export function listTracks(
  client: ApiClient,
  query: TrackListQuery = {},
): Promise<Page<TrackListItem>> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.status) params.set('status', query.status);
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return client.get<Page<TrackListItem>>(`/v1/tracks${qs ? `?${qs}` : ''}`);
}

export function getTrack(client: ApiClient, id: string): Promise<TrackDetail> {
  return client.get<TrackDetail>(`/v1/tracks/${id}`);
}

/**
 * Phase 17 — admin takedown/restore. Sets track status to TAKEDOWN (removes
 * from public catalog) or back to PROCESSING (draft; the ingestion pipeline
 * alone may mark READY). Every change is audited server-side. Callers must
 * confirm first.
 */
export function updateTrackStatus(
  client: ApiClient,
  id: string,
  status: 'TAKEDOWN' | 'PROCESSING',
): Promise<TrackDetail> {
  return client.patch<TrackDetail>(`/v1/tracks/${id}`, { status });
}

/** Deletes a track (soft delete server-side). Callers must confirm first. */
export function deleteTrack(client: ApiClient, id: string): Promise<unknown> {
  return client.delete<unknown>(`/v1/tracks/${id}`);
}
