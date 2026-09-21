// Phase 12 — search domain types.
//
// Search runs against the existing Phase 4 list endpoints (their `q`
// filters), so result items are the same catalog list shapes the rest of
// the app already renders. No backend search endpoint was needed.

import type {
  AlbumListItem,
  ArtistListItem,
  Genre,
  PlaylistListItem,
  TrackListItem,
} from '../api';

export type SearchCategory = 'artists' | 'albums' | 'tracks' | 'genres' | 'playlists';

/** One category of results plus the backend's total for that category. */
export interface CategoryResults<T> {
  items: T[];
  total: number;
}

export interface CategorizedResults {
  artists: CategoryResults<ArtistListItem>;
  albums: CategoryResults<AlbumListItem>;
  tracks: CategoryResults<TrackListItem>;
  genres: CategoryResults<Genre>;
  playlists: CategoryResults<PlaylistListItem>;
}

export const SEARCH_CATEGORIES: SearchCategory[] = [
  'artists',
  'albums',
  'tracks',
  'genres',
  'playlists',
];

export function emptyResults(): CategorizedResults {
  const empty = <T,>(): CategoryResults<T> => ({ items: [], total: 0 });
  return {
    artists: empty(),
    albums: empty(),
    tracks: empty(),
    genres: empty(),
    playlists: empty(),
  };
}

export function totalResultCount(results: CategorizedResults): number {
  return SEARCH_CATEGORIES.reduce((sum, category) => sum + results[category].total, 0);
}

/** A recent search query stored on-device (see recents.ts). */
export interface RecentSearch {
  query: string;
  savedAt: string;
}
