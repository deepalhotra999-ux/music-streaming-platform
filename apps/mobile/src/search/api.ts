// Phase 12 — multi-category search over the existing Phase 4 catalog
// endpoints.
//
// No backend search endpoint exists, and none was needed: every list
// endpoint already supports a case-insensitive `q` filter with the standard
// `{ data, pagination }` envelope. A search is five parallel `q` queries —
// one per category — issued with a small per-category limit. Ordering,
// visibility, and auth boundaries stay server-side: this module forwards
// `q` and reads the envelope, nothing more.
//
// Privacy note: playlists are searched through `listPublicPlaylists`
// (`/v1/playlists/public`) only, so private playlists can never surface in
// results regardless of the viewer's token.

import type { ApiClient, Page } from '../api';
import {
  listAlbums,
  listArtists,
  listGenres,
  listPublicPlaylists,
  listTracks,
} from '../api';
import type { CategorizedResults, CategoryResults, SearchCategory } from './types';

export interface SearchOptions {
  /** Max items fetched per category (backend pagination limit). */
  limitPerCategory?: number;
}

const DEFAULT_LIMIT = 5;

function toCategory<T>(page: Page<T>): CategoryResults<T> {
  return { items: page.data, total: page.pagination.total };
}

export async function searchCatalog(
  client: ApiClient,
  query: string,
  options: SearchOptions = {},
): Promise<CategorizedResults> {
  const q = query.trim();
  const limit = options.limitPerCategory ?? DEFAULT_LIMIT;
  if (!q) {
    throw new Error('searchCatalog requires a non-empty query');
  }

  const [artists, albums, tracks, genres, playlists] = await Promise.all([
    listArtists(client, { q, limit }),
    listAlbums(client, { q, limit }),
    listTracks(client, { q, limit }),
    listGenres(client, { q, limit }),
    listPublicPlaylists(client, { q, limit }),
  ]);

  return {
    artists: toCategory(artists),
    albums: toCategory(albums),
    tracks: toCategory(tracks),
    genres: toCategory(genres),
    playlists: toCategory(playlists),
  };
}

export const CATEGORY_LABELS: Record<SearchCategory, string> = {
  artists: 'Artists',
  albums: 'Albums',
  tracks: 'Tracks',
  genres: 'Genres',
  playlists: 'Playlists',
};
