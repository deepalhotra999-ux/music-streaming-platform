// Phase 6 — catalog endpoints against the Phase 4 API.
// Thin wrappers over ApiClient; no business logic lives here (the backend
// owns filtering, ordering, visibility rules, and pagination).
//
// Every list endpoint speaks the same `?page=&limit=` dialect and returns
// the `{ data, pagination }` envelope. Page/limit are numbers on this side;
// the API validates the string form.

import type { ApiClient } from './client';
import type {
  AlbumDetail,
  AlbumListItem,
  AlbumType,
  ArtistDetail,
  ArtistListItem,
  Genre,
  Page,
  PlaylistDetail,
  PlaylistListItem,
  TrackListItem,
} from './types';

export interface ListQuery {
  page?: number;
  limit?: number;
  /** Backend `q` text filter (name/title search), when the UI offers one. */
  q?: string;
}

export interface ArtistListQuery extends ListQuery {
  verified?: boolean;
}

export interface AlbumListQuery extends ListQuery {
  artistId?: string;
  albumType?: AlbumType;
}

export interface TrackListQuery extends ListQuery {
  artistId?: string;
  albumId?: string;
  genreId?: string;
}

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

// --- Artists ---------------------------------------------------------------

export function listArtists(client: ApiClient, query: ArtistListQuery = {}) {
  return client.get<Page<ArtistListItem>>(
    `/v1/artists${toQueryString({
      page: query.page,
      limit: query.limit,
      q: query.q,
      verified: query.verified,
    })}`,
  );
}

export function getArtist(client: ApiClient, id: string) {
  return client.get<ArtistDetail>(`/v1/artists/${id}`);
}

// --- Albums ----------------------------------------------------------------

export function listAlbums(client: ApiClient, query: AlbumListQuery = {}) {
  return client.get<Page<AlbumListItem>>(
    `/v1/albums${toQueryString({
      page: query.page,
      limit: query.limit,
      q: query.q,
      artistId: query.artistId,
      albumType: query.albumType,
    })}`,
  );
}

export function getAlbum(client: ApiClient, id: string) {
  return client.get<AlbumDetail>(`/v1/albums/${id}`);
}

// --- Tracks ----------------------------------------------------------------

export function listTracks(client: ApiClient, query: TrackListQuery = {}) {
  return client.get<Page<TrackListItem>>(
    `/v1/tracks${toQueryString({
      page: query.page,
      limit: query.limit,
      q: query.q,
      artistId: query.artistId,
      albumId: query.albumId,
      genreId: query.genreId,
    })}`,
  );
}

// --- Genres ----------------------------------------------------------------

export function listGenres(client: ApiClient, query: ListQuery = {}) {
  return client.get<Page<Genre>>(
    `/v1/genres${toQueryString({ page: query.page, limit: query.limit, q: query.q })}`,
  );
}

export function getGenre(client: ApiClient, id: string) {
  return client.get<Genre>(`/v1/genres/${id}`);
}

// --- Playlists (public browsing only) --------------------------------------

export function listPublicPlaylists(client: ApiClient, query: ListQuery = {}) {
  return client.get<Page<PlaylistListItem>>(
    `/v1/playlists/public${toQueryString({ page: query.page, limit: query.limit, q: query.q })}`,
  );
}

/**
 * Public playlists need no token; UNLISTED needs a signed-in viewer (the
 * shared client attaches the token when one exists). PRIVATE is never
 * visible to non-owners (API returns 404).
 */
export function getPlaylist(client: ApiClient, id: string) {
  return client.get<PlaylistDetail>(`/v1/playlists/${id}`);
}
