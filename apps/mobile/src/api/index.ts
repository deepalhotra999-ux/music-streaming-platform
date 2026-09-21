// Phase 5 — API layer public surface.
export { getApiBaseUrl } from './config';
export { ApiClient, ApiError, apiErrorMessage } from './client';
export type { ApiClientOptions, HttpMethod, RequestOptions } from './client';
export { getMe, login, logout, refreshTokens, register } from './auth';
export { createPlaybackSession, reportPlayEvent } from './playback';
export {
  getAlbum,
  getArtist,
  getGenre,
  getPlaylist,
  listAlbums,
  listArtists,
  listGenres,
  listPublicPlaylists,
  listTracks,
} from './catalog';
export type { AlbumListQuery, ArtistListQuery, ListQuery, TrackListQuery } from './catalog';
export type {
  AlbumDetail,
  AlbumListItem,
  AlbumTrack,
  AlbumType,
  ArtistDetail,
  ArtistListItem,
  ArtistProfile,
  AuthResult,
  FieldError,
  Genre,
  LoginInput,
  Page,
  PageInfo,
  PlaybackSession,
  PlayEventType,
  PlaylistDetail,
  PlaylistItem,
  PlaylistListItem,
  PlaylistVisibility,
  ProblemDetail,
  RegisterInput,
  TokenPair,
  TrackDetail,
  TrackGenreRef,
  TrackListItem,
  TrackStatus,
  TrackSummary,
  User,
  UserRole,
} from './types';
