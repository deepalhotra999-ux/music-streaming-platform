// Phase 5 — API layer public surface.
export { getApiBaseUrl } from './config';
export { ApiClient, ApiError, apiErrorMessage } from './client';
export type { ApiClientOptions, HttpMethod, RequestOptions } from './client';
export { getMe, login, logout, refreshTokens, register } from './auth';
export { createPlaybackSession, reportPlayEvent } from './playback';
export {
  getMyEntitlement,
  getMySubscription,
  getStoreProducts,
  verifyPurchase,
} from './subscriptions';
export { getAudioStatus, retryTrackAudio, uploadTrackAudio } from './ingestion';
export type { AudioStatus, UploadableAudio } from './ingestion';
export {
  getArtistAlbumStats,
  getArtistOverview,
  getArtistRecentActivity,
  getArtistTrackStats,
  getArtistTrend,
  getPlatformOverview,
} from './analytics';
export * from './royalties';
export type {
  AlbumAnalytics,
  AnalyticsOverview,
  AnalyticsRange,
  AnalyticsTotals,
  AnalyticsTrend,
  RecentPlay,
  TrackAnalytics,
  TrendGranularity,
  TrendPoint,
} from './types';
export type {
  AnalyticsPagedQuery,
  AnalyticsQuery,
  AnalyticsRecentQuery,
  AnalyticsTrendQuery,
} from './analytics';
export {
  createAlbum,
  createArtist,
  createTrack,
  deleteAlbum,
  deleteArtist,
  deleteTrack,
  listMyArtists,
  updateAlbum,
  updateArtist,
  updateArtistProfile,
  updateTrack,
} from './artist';
export type {
  CreateAlbumInput,
  CreateArtistInput,
  CreateTrackInput,
  UpdateAlbumInput,
  UpdateArtistInput,
  UpdateArtistProfileInput,
  UpdateTrackInput,
} from './artist';
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
export {
  addTrackToPlaylist,
  createPlaylist,
  deletePlaylist,
  followArtist,
  likeTrack,
  listFollowedArtists,
  listHistory,
  listLikedTracks,
  listMyPlaylists,
  movePlaylistItem,
  removePlaylistItem,
  unfollowArtist,
  unlikeTrack,
  updatePlaylist,
} from './library';
export type {
  AddTrackInput,
  AlbumDetail,
  AlbumListItem,
  AlbumTrack,
  AlbumType,
  ArtistDetail,
  ArtistListItem,
  ArtistProfile,
  ArtistSummary,
  AuthResult,
  AudioIngestStatus,
  CreatePlaylistInput,
  FieldError,
  FollowItem,
  Genre,
  HistoryItem,
  LikeItem,
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
  Subscription,
  SubscriptionPlan,
  SubscriptionProvider,
  SubscriptionStatus,
  Entitlement,
  MySubscription,
  StoreProduct,
  StoreProductsResponse,
  VerifyPurchaseResponse,
  TokenPair,
  TrackDetail,
  TrackGenreRef,
  TrackListItem,
  TrackStatus,
  TrackSummary,
  UpdatePlaylistInput,
  User,
  UserRole,
} from './types';
