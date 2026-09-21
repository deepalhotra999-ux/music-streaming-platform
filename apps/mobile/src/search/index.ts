// Phase 12 — search module public surface.

export type {
  CategorizedResults,
  CategoryResults,
  RecentSearch,
  SearchCategory,
} from './types';
export { SEARCH_CATEGORIES, emptyResults, totalResultCount } from './types';
export { CATEGORY_LABELS, searchCatalog } from './api';
export type { SearchOptions } from './api';
export {
  MAX_RECENT_SEARCHES,
  RECENT_SEARCHES_KEY,
  clearRecentSearches,
  loadRecentSearches,
  recordSearch,
  removeRecentSearch,
} from './recents';
export type { RecentSearchStorage } from './recents';
export { useDebouncedValue, useSearch } from './hooks';
export type { SearchResult, SearchState } from './hooks';
export { SearchBar } from './components/SearchBar';
export { RecentSearches } from './components/RecentSearches';
export { SearchResults } from './components/SearchResults';
export type { SearchResultHandlers } from './components/SearchResults';
