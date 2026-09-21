// Phase 6 — catalog UI kit public surface.
export {
  formatAlbumCount,
  formatDuration,
  formatFollowerCount,
  formatReleaseYear,
  formatTotalDuration,
  formatTrackCount,
  hueFor,
  initialFor,
  placeholderBackground,
} from './format';
export { useCatalogDetail, usePaginatedList } from './hooks';
export type { CatalogDetail, PaginatedList } from './hooks';
export { ArtworkImage } from './components/ArtworkImage';
export { SectionHeader } from './components/SectionHeader';
export { AlbumCard, ArtistCard, GenreCard, PlaylistCard } from './components/Cards';
export { AlbumRow, AlbumTrackRow, ArtistRow, PlaylistRow, TrackRow } from './components/Rows';
export { CatalogListScreen } from './components/CatalogListScreen';
