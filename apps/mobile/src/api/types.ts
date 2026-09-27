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

/** Phase 14 — artist audio ingestion lifecycle for a track. */
export type AudioIngestStatus = 'NONE' | 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

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
  audioStatus: AudioIngestStatus;
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
  /** Phase 27 — collaborative playlists. */
  isCollaborative: boolean;
  revision: number;
}

export interface PlaylistDetail extends PlaylistListItem {
  items: PlaylistItem[];
  /** Phase 27 — the caller's role on this playlist (null for non-member viewers). */
  viewerRole: 'OWNER' | 'EDITOR' | null;
}

// ---------------------------------------------------------------------------
// Phase 27 — collaborative playlist contract types.
// Mirror the Phase 27 backend JSON shapes
// (services/api/src/modules/playlists/{schemas,collab}.ts). Plain
// interfaces only; screens never depend on fetch details.
// ---------------------------------------------------------------------------

/** Roles on a collaborative playlist. Only the owner manages settings/membership. */
export type CollaboratorRole = 'OWNER' | 'EDITOR';

/** The caller's relationship to a playlist: owner, editor member, or non-member viewer. */
export type ViewerRole = 'OWNER' | 'EDITOR' | null;

export interface PlaylistMember {
  userId: string;
  displayName: string;
  role: CollaboratorRole;
  joinedAt: string;
}

/**
 * An invitation row. The plaintext token is returned exactly once by
 * createInvitation and is never stored server-side (only its SHA-256
 * hash); it never appears in list responses.
 */
export interface PlaylistInvitation {
  id: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  createdByUserId: string;
  createdAt: string;
}

/** Create-invitation response: the raw token, shown to the owner once. */
export interface CreateInvitationResult {
  token: string;
  invitation: PlaylistInvitation;
}

export interface CollaborationSettings {
  id: string;
  isCollaborative: boolean;
  revision: number;
}

export type PlaylistChangeAction =
  | 'TRACK_ADDED'
  | 'TRACK_REMOVED'
  | 'TRACK_MOVED'
  | 'COLLAB_ENABLED'
  | 'COLLAB_DISABLED'
  | 'MEMBER_ADDED'
  | 'MEMBER_REMOVED'
  | 'MEMBER_LEFT'
  | 'INVITATION_CREATED'
  | 'INVITATION_ACCEPTED'
  | 'INVITATION_REVOKED';

export interface PlaylistChange {
  id: string;
  actorUserId: string;
  actorDisplayName: string;
  action: PlaylistChangeAction;
  trackId: string | null;
  itemId: string | null;
  revision: number;
  createdAt: string;
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

/** Phase 15 — artist analytics & reporting types. All metrics are computed
 *  server-side from the append-only play_events stream; the session is the
 *  unit of a "play" (see ADR-011). */
export type AnalyticsRange = '7d' | '28d' | '90d' | 'all';
export type TrendGranularity = 'day' | 'week';

export interface AnalyticsTotals {
  streams: number;
  starts: number;
  failedPlays: number;
  incompletePlays: number;
  uniqueListeners: number;
  listeningTimeMs: number;
}

export interface AnalyticsOverview extends AnalyticsTotals {
  /** Null for the platform-wide (ADMIN) overview. */
  artistId: string | null;
  range: AnalyticsRange;
  /** Inclusive lower bound, ISO-8601; null for range=all. */
  from: string | null;
  to: string;
}

export interface TrackAnalytics extends AnalyticsTotals {
  trackId: string;
  title: string;
}

export interface AlbumAnalytics extends AnalyticsTotals {
  albumId: string;
  title: string;
}

export interface TrendPoint extends AnalyticsTotals {
  /** UTC bucket start: YYYY-MM-DD (day) or Monday YYYY-MM-DD (week). */
  date: string;
}

export interface AnalyticsTrend {
  granularity: TrendGranularity;
  points: TrendPoint[];
}

export interface RecentPlay {
  sessionId: string;
  trackId: string;
  trackTitle: string;
  playedAt: string;
  listeningTimeMs: number;
}

/** Phase 18 — subscription plan from the server plan catalog. */
export interface SubscriptionPlan {
  id: string;
  name: string;
  planType: 'INDIVIDUAL' | 'FAMILY' | 'STUDENT';
  active: boolean;
}

export type SubscriptionStatus =
  'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED' | 'REVOKED';

export type SubscriptionProvider = 'APPLE' | 'GOOGLE' | 'DEV';

/** Phase 18 — the caller's current subscription, or null when none exists.
 * The API omits external transaction identifiers and the user id from this
 * current-user DTO; the client never needs them. */
export interface Subscription {
  id: string;
  planId: string;
  plan: SubscriptionPlan;
  provider: SubscriptionProvider;
  status: SubscriptionStatus;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Phase 18 — server-computed premium access state. The ONLY source of
 * truth for locked/unlocked UI; the client never decides entitlement.
 */
export interface Entitlement {
  entitled: boolean;
  status: SubscriptionStatus | 'NONE';
  planCode: string | null;
  currentPeriodEnd: string | null;
  reason: string;
}

/** Phase 18 — GET /v1/subscriptions/me response. */
export interface MySubscription {
  subscription: Subscription | null;
  entitlement: Entitlement;
}

/** Phase 19 — a purchasable store product derived from the plan table. */
export interface StoreProduct {
  planCode: string;
  planName: string;
  planType: 'INDIVIDUAL' | 'FAMILY' | 'STUDENT';
  appleProductId: string | null;
  googleProductId: string | null;
  // Billing management — plan catalog pricing (additive; present on the
  // server, optional here so existing mocks keep compiling).
  priceCents?: number;
  currency?: string;
  billingInterval?: 'WEEK' | 'MONTH' | 'YEAR';
  intervalCount?: number;
  trialDays?: number;
  features?: string[];
}

/** Phase 19 — GET /v1/subscriptions/products response. */
export interface StoreProductsResponse {
  products: StoreProduct[];
  appleConfigured: boolean;
  googleConfigured: boolean;
  // Billing management — false when the purchase kill switch is off; the
  // client should hide the paywall and show existing-subscriber state.
  purchasesEnabled?: boolean;
}

/** Phase 19 — POST /v1/subscriptions/verify-purchase response. */
export interface VerifyPurchaseResponse {
  subscription: {
    id: string;
    planId: string;
    provider: string;
    status: string;
  };
  created: boolean;
}
