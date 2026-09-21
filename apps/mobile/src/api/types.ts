// Phase 5 — API contract types.
// Mirrors the backend JSON shapes (services/api/src/modules/auth/schemas.ts).
// Kept as plain interfaces so screens never depend on fetch details.

export type UserRole = 'LISTENER' | 'ARTIST' | 'ADMIN';

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: UserRole;
  emailVerified: boolean;
  countryCode: string | null;
  createdAt: string;
}

export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

export interface AuthResult {
  user: User;
  tokens: TokenPair;
}

export interface FieldError {
  field?: string;
  message: string;
}

/** RFC 7807 problem body returned by the API on errors. */
export interface ProblemDetail {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  errors?: FieldError[];
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

// ---------------------------------------------------------------------------
// Phase 6 — catalog contract types.
// Mirror the Phase 4 backend JSON shapes
// (services/api/src/modules/{artists,albums,tracks,genres,playlists}/schemas.ts).
// Plain interfaces only; screens never depend on fetch details.
// ---------------------------------------------------------------------------

/** Standard `{ data, pagination }` envelope on every list endpoint. */
export interface PageInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Page<T> {
  data: T[];
  pagination: PageInfo;
}

export interface ArtistListItem {
  id: string;
  name: string;
  verified: boolean;
  followerCount: number;
  createdAt: string;
}

export interface ArtistProfile {
  bio: string | null;
  imageUrl: string | null;
  bannerUrl: string | null;
  website: string | null;
  socialLinks: unknown;
}

export interface ArtistDetail {
  id: string;
  name: string;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
  profile: ArtistProfile | null;
  counts: { albums: number; tracks: number; followers: number };
}

export type AlbumType = 'ALBUM' | 'SINGLE' | 'EP' | 'COMPILATION';

export interface AlbumListItem {
  id: string;
  title: string;
  artistId: string;
  artistName: string;
  albumType: AlbumType;
  releaseDate: string | null;
  coverArtUrl: string | null;
  trackCount: number;
  createdAt: string;
}

export interface AlbumTrack {
  id: string;
  title: string;
  durationMs: number;
  trackNumber: number | null;
  discNumber: number;
  status: string;
}

export interface AlbumDetail extends AlbumListItem {
  tracks: AlbumTrack[];
}

export type TrackStatus = 'PROCESSING' | 'READY' | 'FAILED' | 'TAKEDOWN';

export interface TrackListItem {
  id: string;
  title: string;
  artistId: string;
  artistName: string;
  albumId: string | null;
  albumTitle: string | null;
  durationMs: number;
  trackNumber: number | null;
  discNumber: number;
  status: TrackStatus;
  playCount: number;
  createdAt: string;
}

export interface TrackGenreRef {
  id: string;
  name: string;
}

export interface TrackDetail extends TrackListItem {
  isrc: string | null;
  genres: TrackGenreRef[];
  likeCount: number;
}

export interface Genre {
  id: string;
  name: string;
  description: string | null;
  trackCount: number;
}

export type PlaylistVisibility = 'PRIVATE' | 'PUBLIC' | 'UNLISTED';

export interface TrackSummary {
  id: string;
  title: string;
  durationMs: number;
  status: string;
  artistId: string;
  artistName: string;
  albumId: string | null;
  albumTitle: string | null;
}

export interface PlaylistItem {
  id: string;
  position: number;
  addedAt: string;
  track: TrackSummary;
}

export interface PlaylistListItem {
  id: string;
  title: string;
  description: string | null;
  coverArtUrl: string | null;
  visibility: PlaylistVisibility;
  ownerUserId: string;
  ownerDisplayName: string;
  trackCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistDetail extends PlaylistListItem {
  items: PlaylistItem[];
}

/** Phase 7 — playback session. `token` is shown once; `hlsUrl` is a
 *  short-lived, session-scoped HLS master playlist URL (never permanent). */
export interface PlaybackSession {
  id: string;
  token: string;
  expiresAt: string;
  hlsUrl: string;
}

/** Phase 7 — stream telemetry event types (append-only, royalty foundation). */
export type PlayEventType = 'START' | 'HEARTBEAT' | 'COMPLETE' | 'ERROR';

// ---------------------------------------------------------------------------
// Phase 11 — library contract types.
// Mirror the Phase 4 backend JSON shapes
// (services/api/src/modules/{likes,follows,history,playlists}/schemas.ts).
// Plain interfaces only; screens never depend on fetch details.
// ---------------------------------------------------------------------------

export interface ArtistSummary {
  id: string;
  name: string;
  verified: boolean;
}

/** A liked track: the like metadata plus the embedded track summary. */
export interface LikeItem {
  trackId: string;
  createdAt: string;
  track: TrackSummary;
}

/** A followed artist: the follow metadata plus the embedded artist summary. */
export interface FollowItem {
  artistId: string;
  createdAt: string;
  artist: ArtistSummary;
}

/** One listening-history entry with the embedded track summary. */
export interface HistoryItem {
  id: string;
  trackId: string;
  playedAt: string;
  progressMs: number | null;
  completed: boolean;
  track: TrackSummary;
}

export interface CreatePlaylistInput {
  title: string;
  description?: string | null;
  coverArtUrl?: string | null;
  /** Defaults to PRIVATE on the backend when omitted. */
  visibility?: PlaylistVisibility;
}

export interface UpdatePlaylistInput {
  title?: string;
  description?: string | null;
  coverArtUrl?: string | null;
  visibility?: PlaylistVisibility;
}

export interface AddTrackInput {
  trackId: string;
  /** Appends at max(position) + 1 when omitted. */
  position?: number;
}
