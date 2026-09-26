// Phase 16 — admin API contract types.
// Mirror the backend JSON shapes. The admin client NEVER receives or stores
// credential material: no passwordHash, no raw refresh-token rows, no
// signing secrets. Types simply omit those fields so they cannot be
// rendered by accident.

export type UserRole = 'LISTENER' | 'ARTIST' | 'ADMIN';

/**
 * Admin view of a user. Intentionally has no passwordHash, no token fields,
 * no secrets of any kind — the backend never returns them and the UI must
 * never display them.
 */
export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: UserRole;
  emailVerified: boolean;
  countryCode: string | null;
  createdAt: string;
  /** Phase 17 — null = active account; non-null = soft-deleted. */
  deletedAt: string | null;
}

/** Phase 17 — admin-only user detail: account status + owned artists. */
export interface AdminUserDetail extends AdminUser {
  updatedAt: string;
  ownedArtists: {
    id: string;
    name: string;
    verified: boolean;
    createdAt: string;
  }[];
}

/** Phase 18 — subscription status values the admin console may display. */
export type SubscriptionStatus =
  'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED' | 'REVOKED';

export type SubscriptionProvider = 'APPLE' | 'GOOGLE' | 'DEV';

/**
 * Phase 18 — admin subscription inspection. Read-only: status, plan,
 * provider, period, and the server-computed entitlement state. No payment
 * management surface exists.
 *
 * Phase 19 — adds the store product id (resolved from the plan mapping),
 * the verification status (UNVERIFIED/VERIFIED), the last verification
 * timestamp, and the latest event for at-a-glance inspection.
 */
export interface AdminSubscriptionDetail {
  subscription: {
    id: string;
    userId: string;
    planId: string;
    plan: { id: string; name: string; planType: string; active: boolean };
    provider: SubscriptionProvider;
    status: SubscriptionStatus;
    storeProductId: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    canceledAt: string | null;
    verificationStatus: 'UNVERIFIED' | 'VERIFIED';
    lastVerifiedAt: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  entitlement: {
    entitled: boolean;
    status: SubscriptionStatus | 'NONE';
    planCode: string | null;
    currentPeriodEnd: string | null;
    reason: string;
  };
  events: {
    id: string;
    eventType: string;
    statusFrom: SubscriptionStatus | null;
    statusTo: SubscriptionStatus | null;
    createdAt: string;
  }[];
  latestEvent: {
    id: string;
    eventType: string;
    statusFrom: SubscriptionStatus | null;
    statusTo: SubscriptionStatus | null;
    createdAt: string;
  } | null;
}

export type ModerationTargetType =
  | 'ARTIST'
  | 'ALBUM'
  | 'TRACK'
  // Phase 29 — community content reports. Users file these through the
  // user-facing reports endpoint; admins review them in the same queue.
  | 'ARTIST_POST'
  | 'POST_COMMENT';
export type ModerationStatus = 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED' | 'DISMISSED';

/** Phase 29 — safe public author DTO shared with the community surfaces. */
export interface CommunityAuthor {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export type CommunityContentStatus = 'ACTIVE' | 'DELETED' | 'REMOVED';

/** Phase 29 — an artist post as seen by the admin review UI (any status). */
export interface CommunityPost {
  id: string;
  artist: { id: string; name: string; verified: boolean };
  author: CommunityAuthor;
  body: string;
  track: { id: string; title: string; artistName: string } | null;
  album: { id: string; title: string; artistName: string } | null;
  status: CommunityContentStatus;
  reactionCount: number;
  commentCount: number;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Phase 29 — a post comment as seen by the admin review UI (any status). */
export interface CommunityComment {
  id: string;
  postId: string;
  author: CommunityAuthor;
  body: string;
  status: CommunityContentStatus;
  createdAt: string;
  updatedAt: string;
}

/** Phase 17 — one moderation report. History lives in the audit log. */
export interface ModerationReport {
  id: string;
  targetType: ModerationTargetType;
  targetId: string;
  reason: string;
  details: string | null;
  status: ModerationStatus;
  createdById: string | null;
  reviewedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

export interface AuthResult {
  user: AdminUser;
  tokens: TokenPair;
}

export interface LoginInput {
  email: string;
  password: string;
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
  updatedAt: string;
}

export type AnalyticsRange = '7d' | '28d' | '90d' | 'all';

/**
 * Platform-wide overview computed server-side from the play_events stream
 * (GET /v1/analytics/platform/overview). The client displays these numbers
 * verbatim and MUST NOT recompute, reinterpret, or derive new metrics from
 * them. Extra/unknown fields are ignored, never displayed as authoritative.
 */
export interface PlatformOverview {
  artistId: string | null;
  range: AnalyticsRange;
  from: string | null;
  to: string;
  streams: number;
  starts: number;
  failedPlays: number;
  incompletePlays: number;
  uniqueListeners: number;
  listeningTimeMs: number;
  outcomes?: Record<string, number>;
}

/** One immutable audit row. Read-only: the UI never edits or deletes these. */
export interface AuditLog {
  id: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
