// Phase 11 — authenticated library endpoints against the Phase 4 API.
//
// Likes, follows, listening history, and the caller's own playlists plus
// every playlist mutation. Thin wrappers over ApiClient; the backend owns
// ordering, visibility rules, and pagination. All of these require a Bearer
// token (the shared client attaches it).

import type { ApiClient } from './client';
import type {
  AddTrackInput,
  CreatePlaylistInput,
  FollowItem,
  HistoryItem,
  LikeItem,
  Page,
  PlaylistDetail,
  PlaylistItem,
  PlaylistListItem,
  UpdatePlaylistInput,
} from './types';
import type { ListQuery } from './catalog';

export type LibraryQuery = Pick<ListQuery, 'page' | 'limit'>;

function toQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

// --- Likes -----------------------------------------------------------------

export function listLikedTracks(client: ApiClient, query: LibraryQuery = {}) {
  return client.get<Page<LikeItem>>(
    `/v1/me/likes${toQueryString({ page: query.page, limit: query.limit })}`,
  );
}

/** Idempotent: 201 when newly liked, 200 when it was already liked. */
export function likeTrack(client: ApiClient, trackId: string) {
  return client.post<LikeItem>('/v1/me/likes', { trackId });
}

/** Idempotent: always 204, even when the track was not liked. */
export function unlikeTrack(client: ApiClient, trackId: string): Promise<void> {
  return client.delete<void>(`/v1/me/likes/${trackId}`);
}

// --- Follows ---------------------------------------------------------------

export function listFollowedArtists(client: ApiClient, query: LibraryQuery = {}) {
  return client.get<Page<FollowItem>>(
    `/v1/me/follows${toQueryString({ page: query.page, limit: query.limit })}`,
  );
}

export function followArtist(client: ApiClient, artistId: string) {
  return client.post<FollowItem>('/v1/me/follows', { artistId });
}

export function unfollowArtist(client: ApiClient, artistId: string): Promise<void> {
  return client.delete<void>(`/v1/me/follows/${artistId}`);
}

// --- Listening history -----------------------------------------------------

export function listHistory(client: ApiClient, query: LibraryQuery = {}) {
  return client.get<Page<HistoryItem>>(
    `/v1/me/history${toQueryString({ page: query.page, limit: query.limit })}`,
  );
}

// --- My playlists ----------------------------------------------------------

export function listMyPlaylists(client: ApiClient, query: LibraryQuery = {}) {
  return client.get<Page<PlaylistListItem>>(
    `/v1/me/playlists${toQueryString({ page: query.page, limit: query.limit })}`,
  );
}

/** Creates a playlist owned by the caller (defaults to PRIVATE). */
export function createPlaylist(client: ApiClient, input: CreatePlaylistInput) {
  return client.post<PlaylistDetail>('/v1/playlists', input);
}

/** Owner only; non-owners get 404 from the backend. */
export function updatePlaylist(client: ApiClient, id: string, input: UpdatePlaylistInput) {
  return client.patch<PlaylistDetail>(`/v1/playlists/${id}`, input);
}

/** Owner only, soft delete; resolves on 204. */
export function deletePlaylist(client: ApiClient, id: string): Promise<void> {
  return client.delete<void>(`/v1/playlists/${id}`);
}

// --- Playlist tracks (owner only) ------------------------------------------

export function addTrackToPlaylist(client: ApiClient, id: string, input: AddTrackInput) {
  return client.post<PlaylistItem>(`/v1/playlists/${id}/tracks`, input);
}

export function movePlaylistItem(
  client: ApiClient,
  id: string,
  itemId: string,
  position: number,
) {
  return client.patch<PlaylistItem>(`/v1/playlists/${id}/tracks/${itemId}`, { position });
}

export function removePlaylistItem(
  client: ApiClient,
  id: string,
  itemId: string,
): Promise<void> {
  return client.delete<void>(`/v1/playlists/${id}/tracks/${itemId}`);
}
