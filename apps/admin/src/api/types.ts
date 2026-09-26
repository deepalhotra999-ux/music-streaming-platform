// Phase 16 — admin API contract types.
// Mirror the backend JSON shapes. The admin client NEVER receives or stores
// credential material: no passwordHash, no raw refresh-token rows, no
// signing secrets. Types simply omit those fields so they cannot be
// rendered by accident.

export type UserRole = 'LISTENER' | 'ARTIST' | 'ADMIN';

/**
 * Admin V2 — all roles known to the backend authorization model.
 * Named operational roles hold server-defined permission bundles plus
 * additive per-account grants; SUPER_ADMIN holds everything; legacy ADMIN
 * holds only its frozen pre-Admin-V2 bundle.
 */
export type AdminUserRole =
  | 'LISTENER'
  | 'ARTIST'
  | 'ADMIN'
  | 'SUPER_ADMIN'
  | 'PLATFORM_ADMIN'
  | 'MODERATOR'
  | 'SUPPORT_ADMIN'
  | 'FINANCE_ADMIN'
  | 'CONTENT_ADMIN'
  | 'ARTIST_ADMIN'
  | 'ANALYTICS_ADMIN';

export const ADMIN_ROLES: readonly AdminUserRole[] = [
  'SUPER_ADMIN',
  'PLATFORM_ADMIN',
  'MODERATOR',
  'SUPPORT_ADMIN',
  'FINANCE_ADMIN',
  'CONTENT_ADMIN',
  'ARTIST_ADMIN',
  'ANALYTICS_ADMIN',
  'ADMIN',
];

/** UX-side mirror of the server's admin-tier check. The server re-decides. */
export function isAdminRole(role: string): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

/** Admin V2 permission keys issued by GET /v1/admin/me/permissions. */
export type PermissionKey =
  | 'users.view'
  | 'users.edit'
  | 'users.credentials'
  | 'users.ban'
  | 'users.impersonate'
  | 'roles.manage'
  | 'subscriptions.manage'
  | 'finance.view'
  | 'royalties.manage'
  | 'commerce.manage'
  | 'content.moderate'
  | 'reports.moderate'
  | 'audit.view'
  | 'security.view'
  | 'jobs.view'
  | 'webhooks.view'
  | 'system.view'
  | 'flags.manage'
  | 'settings.manage'
  | 'audit.reverse';

/**
 * Admin V2 — the full admin tier. Legacy 'ADMIN' is the pre-Admin-V2 role
 * with a fixed restricted bundle; the named operational roles hold
 * server-defined permission bundles plus optional additive per-account
 * grants. SUPER_ADMIN holds every permission.
 */
export type AdminV2Role =
  | 'SUPER_ADMIN'
  | 'PLATFORM_ADMIN'
  | 'MODERATOR'
  | 'SUPPORT_ADMIN'
  | 'FINANCE_ADMIN'
  | 'CONTENT_ADMIN'
  | 'ARTIST_ADMIN'
  | 'ANALYTICS_ADMIN';

/** Any role that may hold admin powers (legacy + named Admin V2 roles). */
export type AnyAdminRole = 'ADMIN' | AdminV2Role;

/** Roles that can be assigned to a user account, admin or consumer. */
export type AssignableRole = UserRole | AnyAdminRole;

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
  role: AdminUserRole;
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
  /**
   * Admin V2 — ban state. These fields exist on the backend user row; they are
   * optional here until the backend detail DTO carries them (see report).
   */
  bannedAt?: string | null;
  banReason?: string | null;
  bannedUntil?: string | null;
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
  /**
   * Admin V2 — reversibility. A reversal is itself a new audit row; history
   * is never rewritten. `reversible` marks rows the server knows how to
   * invert; `reversedBy`/`reversalOf` link the chain.
   */
  reversible?: boolean;
  reversedBy?: string | null;
  reversalOf?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Admin V2 — operations center DTOs. All numbers come from the server; the
// client displays them verbatim and never invents metrics.
// ---------------------------------------------------------------------------

/** The caller's effective permissions, resolved fresh from the database. */
export interface MyPermissions {
  role: string;
  permissions: string[];
}

export interface CommandCenter {
  generatedAt: string;
  users: { total: number; new7d: number; active30d: number; suspended: number; adminCount: number };
  artists: { total: number; verified: number; unverified: number; suspended: number };
  playback: {
    sessions24h: number;
    streams7d: number;
    listeningTimeMs7d: number;
    uniqueListeners7d: number;
    errors24h: number;
    activeSessions: number;
  };
  catalog: {
    tracks: number;
    tracksReady: number;
    tracksProcessing: number;
    tracksFailed: number;
    tracksTakedown: number;
    albums: number;
  };
  subscriptions: { total: number; byStatus: Record<string, number>; entitledNow: number };
  finance: {
    commerceRevenueCents: number;
    commerceRefundsCents: number;
    royaltyAllocated: string;
    royaltyCurrency: string | null;
    chargebacks: number;
  };
  commerce: {
    orders: number;
    ordersByStatus: Record<string, number>;
    stores: number;
    products: number;
  };
  community: { posts: number; comments: number; openReports: number };
  ingestion: { processing: number; failed: number; succeededJobs: number; failedJobs: number };
  webhooks: {
    subscription: { received: number; duplicates: number; failed: number };
    commerce: { received: number; duplicates: number; failed: number };
  };
  system: {
    uptimeSeconds: number;
    requestsTotal: number;
    requests5xx: number;
    authFailures: number;
    rateLimitHits: number;
    dbErrors: number;
    wsCurrent: number;
    maintenanceMode: boolean;
    readonlyMode: boolean;
  };
}

export type SearchResultType =
  | 'user'
  | 'artist'
  | 'album'
  | 'track'
  | 'playlist'
  | 'order'
  | 'store'
  | 'post'
  | 'report'
  | 'audit';

export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  subtitle: string;
  url: string | null;
}

export interface GlobalSearchResult {
  results: SearchResult[];
  excludedTypes: SearchResultType[];
}

export interface TimelineItem {
  at: string;
  kind: 'audit' | 'subscription' | 'chargeback' | 'royalty' | 'ingestion' | 'report';
  title: string;
  detail: string | null;
  url: string | null;
}

export interface ArtistAdminDetail {
  id: string;
  name: string;
  verified: boolean;
  suspendedAt: string | null;
  suspendedReason: string | null;
  owner: { id: string; email: string; displayName: string } | null;
  counts: { albums: number; tracks: number; followers: number; posts: number; stores: number };
  takedownTracks: number;
  openReports: number;
  orders: number;
  royalty: { total: string; currency: string | null };
}

export interface BulkTrackResult {
  updated: string[];
  skipped: { id: string; reason: string }[];
}

export interface SecurityOverview {
  generatedAt: string;
  logins24h: { total: number; failed: number };
  topFailedEmails: { email: string; failures: number }[];
  activeSessions: number;
  bannedUsers: number;
  lockedOutIps24h: number;
  authFailures: number;
  rateLimitHits: number;
  recentFailures: {
    id: string;
    email: string;
    ipAddress: string | null;
    failureReason: string | null;
    createdAt: string;
  }[];
}

export interface AdminSession {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface JobsOverview {
  generatedAt: string;
  note: string;
  ingestion: {
    queued: number;
    processing: number;
    failed: number;
    ready: number;
    recentFailed: { id: string; title: string; artistName: string | null; updatedAt: string }[];
  };
  royaltyRuns: {
    succeeded: number;
    failed: number;
    recent: {
      id: string;
      status: string;
      totalAllocated: string;
      currency: string;
      createdAt: string;
    }[];
  };
}

export interface WebhooksOverview {
  generatedAt: string;
  note: string;
  subscription: {
    received: number;
    duplicates: number;
    failed: number;
    recent: {
      id: string;
      eventType: string;
      statusFrom: string | null;
      statusTo: string | null;
      provider: string;
      createdAt: string;
    }[];
  };
  commerce: {
    received: number;
    duplicates: number;
    failed: number;
    recent: { id: string; eventType: string; paymentId: string; createdAt: string }[];
  };
}

export interface SystemHealth {
  generatedAt: string;
  api: { status: 'ok'; uptimeSeconds: number };
  database: { status: 'ok' | 'error'; latencyMs: number | null; error: string | null };
  storage: { driver: string; status: 'ok' | 'unknown' };
  emergency: { maintenanceMode: boolean; readonlyMode: boolean; newSignupsEnabled: boolean };
  metrics: { requestsTotal: number; requests5xx: number; dbErrors: number; wsCurrent: number };
}

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  rolloutPercent: number;
  description: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface PlatformSetting {
  key: string;
  value: unknown;
  updatedAt: string;
  updatedBy: string | null;
}

export interface FinanceSubscriptions {
  byStatus: { status: string; count: number }[];
  byPlan: { planId: string; planName: string; count: number }[];
  trialing: number;
  chargebacks: { count: number; amountCents: number };
  recentEvents: {
    id: string;
    eventType: string;
    statusFrom: string | null;
    statusTo: string | null;
    createdAt: string;
  }[];
}

export interface FinanceCommerce {
  grossCents: number;
  refundedCents: number;
  netCents: number;
  byStatus: { status: string; count: number }[];
  refunds: { count: number; amountCents: number };
  recentRefunds: {
    id: string;
    orderId: string;
    amountCents: number;
    currency: string;
    createdAt: string;
  }[];
}

export interface FinanceRoyalties {
  runs: {
    id: string;
    status: string;
    royaltyPool: string;
    totalAllocated: string;
    residualAmount: string;
    createdAt: string;
  }[];
  totals: { runs: number; allocated: string; adjustments: number; adjustmentAmount: string };
  recentAdjustments: {
    id: string;
    runId: string;
    artistId: string;
    amount: string;
    currency: string;
    reason: string;
    createdAt: string;
  }[];
}

export interface ModerationOverview {
  byStatus: { status: string; count: number }[];
  byTargetType: { targetType: string; count: number }[];
  oldestOpen: { id: string; targetType: string; createdAt: string } | null;
  recent: { id: string; targetType: string; status: string; createdAt: string }[];
}

export interface AdminAccount {
  id: string;
  email: string;
  displayName: string;
  role: string;
  bundlePermissions: string[];
  grantedPermissions: string[];
  effectivePermissions: string[];
  createdAt: string;
}

export interface RoleCatalog {
  roles: { role: string; bundlePermissions: string[] }[];
  permissions: { key: string; description: string }[];
  assignableRoles: string[];
}

export interface UserSession {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface LoginEvent {
  id: string;
  email: string;
  success: boolean;
  failureReason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface AppHistoryItem {
  id: string;
  trackId: string;
  playedAt: string;
}

export interface Chargeback {
  id: string;
  providerRef: string | null;
  amountCents: number | null;
  currency: string | null;
  reason: string | null;
  createdAt: string;
}

export interface ReversalResult {
  reversedAction: string;
  restoredSummary: Record<string, unknown>;
}

/**
 * Impersonation token payload claims. DISPLAY ONLY: the server verifies the
 * signature and enforces every rule; the client must never treat these claims
 * as authorization.
 */
export interface ImpersonationClaims {
  imp: true;
  actorId: string;
  reason: string;
  impStartedAt: string;
  sub: string;
  email: string;
  role: string;
  iat: number;
  exp: number;
}

export interface ImpersonationSession {
  token: string;
  expiresAt: string;
}
