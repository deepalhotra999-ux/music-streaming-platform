// Phase 26 — discovery module public surface.

export * from './types';
export {
  getEmergingArtists,
  getPlaylistCriteria,
  getRecommendations,
  queryDiscovery,
  type PlaylistCriteriaInput,
  type RecommendationsQuery,
} from './api';
export {
  useDiscoveryQuery,
  useEmergingArtists,
  useRecommendations,
  type DiscoveryQueryResult,
  type DiscoveryState,
  type EmergingArtistsResult,
  type QuerySubmitState,
  type RecommendationsResult,
} from './hooks';
export { ColdStartBanner } from './components/ColdStartBanner';
export { DiscoveryTrackRow } from './components/DiscoveryTrackRow';
export { EmergingArtistRow } from './components/EmergingArtistRow';
export { QueryBar } from './components/QueryBar';
