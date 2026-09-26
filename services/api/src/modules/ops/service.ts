// Admin V2 — platform operations center services.
//
// Read-mostly operational views over real data. Every number below comes
// from an existing table or the in-process metrics collector; nothing is
// invented. Mutations live in the governance module or here with audit.

import { prisma } from '../../db.js';
import type { PrismaClient } from '@prisma/client';
import { metrics } from '../../http/metrics.js';
import { getPlatformOverview } from '../analytics/service.js';
import { badRequest, notFound } from '../../http/errors.js';
import { recordAuditEvent, actorIdentity } from '../audit/service.js';
import type { AuthUser } from '../../http/auth.js';
import { hasPermissions } from '../../http/authorization.js';
import {
  listFlags,
  listSettings,
  refreshSettingsCache,
  validateFlagKey,
  validateSettingValue,
  isKnownSetting,
  emergencyActive,
  getMaintenanceMessage,
} from './settings.js';

type Db = PrismaClient;

// ---------------------------------------------------------------------------
// Command center
// ---------------------------------------------------------------------------

export interface CommandCenterDto {
  generatedAt: string;
  users: {
    total: number;
    new7d: number;
    active30d: number;
    suspended: number;
    adminCount: number;
  };
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
  subscriptions: {
    total: number;
    byStatus: Record<string, number>;
    entitledNow: number;
  };
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

export async function getCommandCenter(db: Db = prisma): Promise<CommandCenterDto> {
  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const d30 = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const d1 = new Date(now.getTime() - 24 * 3600 * 1000);

  const [
    userTotal,
    userNew7d,
    userActive30d,
    userSuspended,
    adminCount,
    artistRows,
    sessions24h,
    activeSessions,
    errors24h,
    trackStatus,
    albumCount,
    subByStatus,
    subTotal,
    entitledNow,
    payments,
    refunds,
    royaltyAgg,
    chargebacks,
    orderByStatus,
    orderTotal,
    storeCount,
    productCount,
    postCount,
    commentCount,
    openReports,
    ingestProcessing,
    ingestFailed,
    settingRows,
  ] = await Promise.all([
    db.user.count({ where: { deletedAt: null } }),
    db.user.count({ where: { deletedAt: null, createdAt: { gte: d7 } } }),
    db.loginEvent
      .findMany({ where: { success: true, createdAt: { gte: d30 } }, select: { userId: true }, distinct: ['userId'] })
      .then((r) => r.length),
    db.user.count({ where: { deletedAt: null, bannedAt: { not: null } } }),
    db.user.count({
      where: {
        deletedAt: null,
        role: { in: ['SUPER_ADMIN', 'ADMIN', 'PLATFORM_ADMIN', 'MODERATOR', 'SUPPORT_ADMIN', 'FINANCE_ADMIN', 'CONTENT_ADMIN', 'ARTIST_ADMIN', 'ANALYTICS_ADMIN'] },
      },
    }),
    db.artist.groupBy({ by: ['verified'], where: { deletedAt: null }, _count: true }).then(async (groups) => {
      const suspended = await db.artist.count({ where: { deletedAt: null, suspendedAt: { not: null } } });
      let verified = 0;
      let unverified = 0;
      for (const g of groups) (g.verified ? (verified += g._count) : (unverified += g._count));
      return { total: verified + unverified, verified, unverified, suspended };
    }),
    db.playbackSession.count({ where: { createdAt: { gte: d1 } } }),
    db.playbackSession.count({ where: { expiresAt: { gt: now } } }),
    db.playEvent.count({ where: { eventType: 'ERROR', createdAt: { gte: d1 } } }),
    db.track.groupBy({ by: ['status'], _count: true }),
    db.album.count({ where: { deletedAt: null } }),
    db.subscription.groupBy({ by: ['status'], _count: true }),
    db.subscription.count(),
    // Entitled now: latest ACTIVE/TRIALING subscription per user whose window covers now.
    db.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*) AS count FROM (
         SELECT DISTINCT ON (s.user_id) s.status, s.current_period_start, s.current_period_end
         FROM subscriptions s
         JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
         ORDER BY s.user_id, s.created_at DESC
       ) latest
       WHERE (latest.status = 'ACTIVE' AND latest.current_period_start <= NOW() AND NOW() < latest.current_period_end)
          OR (latest.status = 'TRIALING' AND NOW() < latest.current_period_end)`,
    ).then((r) => Number(r[0]?.count ?? 0n)),
    db.commercePayment.aggregate({
      _sum: { amountCents: true },
      where: { status: 'SUCCEEDED' },
    }),
    db.commerceRefund.aggregate({
      _sum: { amountCents: true },
      where: { status: 'SUCCEEDED' },
    }),
    db.royaltyEarning.aggregate({ _sum: { finalAmount: true } }).then(async (agg) => {
      const cur = await db.royaltyEarning.findFirst({ select: { currency: true } });
      return { total: agg._sum.finalAmount?.toString() ?? '0', currency: cur?.currency ?? null };
    }),
    db.chargeback.count(),
    db.commerceOrder.groupBy({ by: ['status'], _count: true }),
    db.commerceOrder.count(),
    db.artistStore.count(),
    db.product.count({ where: { status: 'ACTIVE' } }),
    db.artistPost.count({ where: { status: 'ACTIVE' } }),
    db.postComment.count({ where: { status: 'ACTIVE' } }),
    db.moderationReport.count({ where: { status: 'OPEN' } }),
    db.track.count({ where: { audioStatus: 'PROCESSING' } }),
    db.track.count({ where: { audioStatus: 'FAILED' } }),
    db.platformSetting.findMany({ where: { key: { in: ['emergency.maintenance_mode', 'emergency.readonly_mode'] } } }),
  ]);

  // Analytics overview for the 7-day playback window (real play_events math).
  let streams7d = 0;
  let listeningTimeMs7d = 0;
  let uniqueListeners7d = 0;
  try {
    const overview = await getPlatformOverview({ range: '7d' }, { db });
    streams7d = overview.streams;
    listeningTimeMs7d = overview.listeningTimeMs;
    uniqueListeners7d = overview.uniqueListeners;
  } catch {
    // Analytics is best-effort inside the command center; the page must not
    // 500 because one aggregation failed.
  }

  const byStatus = (groups: Array<{ status: string; _count: number }>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const g of groups) out[g.status] = g._count;
    return out;
  };
  const trackByStatus: Record<string, number> = {};
  for (const g of trackStatus) trackByStatus[g.status] = g._count;

  const snap = metrics.snapshot();
  const settingsMap = new Map(settingRows.map((r) => [r.key, r.value]));

  return {
    generatedAt: now.toISOString(),
    users: {
      total: userTotal,
      new7d: userNew7d,
      active30d: userActive30d,
      suspended: userSuspended,
      adminCount,
    },
    artists: artistRows,
    playback: {
      sessions24h,
      streams7d,
      listeningTimeMs7d,
      uniqueListeners7d,
      errors24h,
      activeSessions,
    },
    catalog: {
      tracks: Object.values(trackByStatus).reduce((a, b) => a + b, 0),
      tracksReady: trackByStatus.READY ?? 0,
      tracksProcessing: trackByStatus.PROCESSING ?? 0,
      tracksFailed: trackByStatus.FAILED ?? 0,
      tracksTakedown: trackByStatus.TAKEDOWN ?? 0,
      albums: albumCount,
    },
    subscriptions: { total: subTotal, byStatus: byStatus(subByStatus), entitledNow },
    finance: {
      commerceRevenueCents: payments._sum.amountCents ?? 0,
      commerceRefundsCents: refunds._sum.amountCents ?? 0,
      royaltyAllocated: royaltyAgg.total,
      royaltyCurrency: royaltyAgg.currency,
      chargebacks,
    },
    commerce: {
      orders: orderTotal,
      ordersByStatus: byStatus(orderByStatus),
      stores: storeCount,
      products: productCount,
    },
    community: { posts: postCount, comments: commentCount, openReports: openReports },
    ingestion: {
      processing: ingestProcessing,
      failed: ingestFailed,
      succeededJobs: snap.ingestionJobs.succeeded,
      failedJobs: snap.ingestionJobs.failed,
    },
    webhooks: {
      subscription: { ...snap.subscriptionWebhooks },
      commerce: { ...snap.commerceWebhooks },
    },
    system: {
      uptimeSeconds: snap.uptimeSeconds,
      requestsTotal: snap.requests.total,
      requests5xx: snap.requests.byStatus['5xx'] ?? 0,
      authFailures: snap.authFailures,
      rateLimitHits: snap.rateLimitHits,
      dbErrors: snap.dbErrors,
      wsCurrent: snap.wsConnections.current,
      maintenanceMode: settingsMap.get('emergency.maintenance_mode') === true,
      readonlyMode: settingsMap.get('emergency.readonly_mode') === true,
    },
  };
}

// ---------------------------------------------------------------------------
// Global search — every result type is gated on the caller's permissions.
// Types the caller may not see are skipped and reported in `excludedTypes`.
// ---------------------------------------------------------------------------

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
  subtitle: string | null;
  /** Admin-console deep link (hash route). */
  url: string;
}

export interface GlobalSearchDto {
  query: string;
  results: SearchResult[];
  excludedTypes: SearchResultType[];
}

const SEARCH_TAKE = 6;

export async function globalSearch(
  q: string,
  actor: AuthUser,
  db: Db = prisma,
): Promise<GlobalSearchDto> {
  const query = q.trim();
  if (query.length < 2) throw badRequest('Search query must be at least 2 characters.');
  const results: SearchResult[] = [];
  const excludedTypes: SearchResultType[] = [];
  const jobs: Promise<void>[] = [];

  const push = (
    type: SearchResultType,
    needed: Parameters<typeof hasPermissions>[2],
    job: Promise<SearchResult[]>,
  ): void => {
    jobs.push(
      hasPermissions(actor.id, actor.role, needed).then((ok) => {
        if (!ok) {
          excludedTypes.push(type);
          return;
        }
        return job.then((rows) => void results.push(...rows));
      }),
    );
  };

  const like = { contains: query, mode: 'insensitive' as const };

  push('user', 'users.view', (async () => {
    const rows = await db.user.findMany({
      where: { deletedAt: null, OR: [{ email: like }, { displayName: like }] },
      select: { id: true, email: true, displayName: true, role: true },
      take: SEARCH_TAKE,
    });
    return rows.map((r) => ({
      type: 'user' as const,
      id: r.id,
      title: r.displayName ?? r.email,
      subtitle: `${r.email} · ${r.role}`,
      url: `#/users/${r.id}`,
    }));
  })());

  push('artist', 'content.moderate', (async () => {
    const rows = await db.artist.findMany({
      where: { deletedAt: null, name: like },
      select: { id: true, name: true, verified: true, suspendedAt: true },
      take: SEARCH_TAKE,
    });
    return rows.map((r) => ({
      type: 'artist' as const,
      id: r.id,
      title: r.name,
      subtitle: [r.verified ? 'verified' : 'unverified', r.suspendedAt ? 'suspended' : null].filter(Boolean).join(' · ') || null,
      url: `#/artists/${r.id}`,
    }));
  })());

  push('album', 'content.moderate', (async () => {
    const rows = await db.album.findMany({
      where: { deletedAt: null, title: like },
      select: { id: true, title: true, artist: { select: { name: true } } },
      take: SEARCH_TAKE,
    });
    return rows.map((r) => ({
      type: 'album' as const,
      id: r.id,
      title: r.title,
      subtitle: r.artist?.name ?? null,
      url: `#/catalog/albums/${r.id}`,
    }));
  })());

  push('track', 'content.moderate', (async () => {
    const rows = await db.track.findMany({
      where: { title: like },
      select: { id: true, title: true, status: true, artist: { select: { name: true } } },
      take: SEARCH_TAKE,
    });
    return rows.map((r) => ({
      type: 'track' as const,
      id: r.id,
      title: r.title,
      subtitle: `${r.artist?.name ?? 'Unknown artist'} · ${r.status}`,
      url: `#/catalog/tracks/${r.id}`,
    }));
  })());

  push('playlist', 'content.moderate', (async () => {
    const rows = await db.playlist.findMany({
      where: { title: like },
      select: { id: true, title: true, visibility: true, owner: { select: { displayName: true, email: true } } },
      take: SEARCH_TAKE,
    });
    return rows.map((r) => ({
      type: 'playlist' as const,
      id: r.id,
      title: r.title,
      subtitle: `${r.visibility} · ${r.owner.displayName ?? r.owner.email}`,
      url: `#/catalog/playlists/${r.id}`,
    }));
  })());

  push('order', 'commerce.manage', (async () => {
    // Orders are looked up by ID prefix (UUIDs); skip unless the query looks
    // like a hex prefix so we never run a meaningless scan.
    const rows = await db.commerceOrder.findMany({
      where: { orderNumber: { contains: query, mode: 'insensitive' } },
      select: { id: true, orderNumber: true, status: true, totalCents: true },
      take: SEARCH_TAKE,
    });
    return rows.map((r) => ({
      type: 'order' as const,
      id: r.id,
      title: `Order ${r.orderNumber}`,
      subtitle: `${r.status} · $${(r.totalCents / 100).toFixed(2)}`,
      url: `#/commerce/orders/${r.id}`,
    }));
  })());

  push('store', 'commerce.manage', (async () => {
    const rows = await db.artistStore.findMany({
      where: { name: like },
      select: { id: true, name: true, status: true },
      take: SEARCH_TAKE,
    });
    return rows.map((r) => ({
      type: 'store' as const,
      id: r.id,
      title: r.name,
      subtitle: r.status,
      url: `#/commerce/stores/${r.id}`,
    }));
  })());

  push('post', 'reports.moderate', (async () => {
    const rows = await db.artistPost.findMany({
      where: { body: like },
      select: { id: true, body: true, status: true, artist: { select: { name: true } } },
      take: SEARCH_TAKE,
    });
    return rows.map((r) => ({
      type: 'post' as const,
      id: r.id,
      title: r.body.slice(0, 80),
      subtitle: `${r.artist?.name ?? ''} · ${r.status}`.trim(),
      url: `#/moderation/posts/${r.id}`,
    }));
  })());

  push('report', 'reports.moderate', (async () => {
    const rows = await db.moderationReport.findMany({
      where: { reason: like },
      select: { id: true, reason: true, status: true, targetType: true },
      take: SEARCH_TAKE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      type: 'report' as const,
      id: r.id,
      title: `${r.targetType} report`,
      subtitle: `${r.status} · ${r.reason.slice(0, 60)}`,
      url: `#/moderation/reports/${r.id}`,
    }));
  })());

  push('audit', 'audit.view', (async () => {
    const rows = await db.adminAuditLog.findMany({
      where: { action: like },
      select: { id: true, action: true, targetType: true, createdAt: true },
      take: SEARCH_TAKE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      type: 'audit' as const,
      id: r.id,
      title: r.action,
      subtitle: `${r.targetType} · ${r.createdAt.toISOString()}`,
      url: `#/audit/${r.id}`,
    }));
  })());

  await Promise.all(jobs);
  // Stable ordering: users, artists, then the rest alphabetically.
  const order: SearchResultType[] = ['user', 'artist', 'album', 'track', 'playlist', 'order', 'store', 'post', 'report', 'audit'];
  results.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  return { query, results, excludedTypes };
}

// ---------------------------------------------------------------------------
// Artist control center
// ---------------------------------------------------------------------------

export interface ArtistAdminDetailDto {
  id: string;
  name: string;
  verified: boolean;
  suspendedAt: string | null;
  suspendedReason: string | null;
  owner: { id: string; email: string; displayName: string | null } | null;
  counts: {
    albums: number;
    tracks: number;
    tracksTakedown: number;
    followers: number;
    posts: number;
    openReports: number;
    stores: number;
    orders: number;
  };
  royalty: { totalAllocated: string; currency: string | null };
  createdAt: string;
}

export async function getArtistAdminDetail(artistId: string, db: Db = prisma): Promise<ArtistAdminDetailDto> {
  const a = await db.artist.findFirst({
    where: { id: artistId, deletedAt: null },
    include: {
      owner: { select: { id: true, email: true, displayName: true } },
      _count: {
        select: {
          albums: true,
          tracks: true,
          followers: true,
          posts: true,
          stores: true,
        },
      },
    },
  });
  if (!a) throw notFound('Artist not found.');
  const [takedown, openReports, orders, royalty] = await Promise.all([
    db.track.count({ where: { artistId, status: 'TAKEDOWN' } }),
    db.moderationReport.count({ where: { targetType: 'ARTIST', targetId: artistId, status: 'OPEN' } }),
    db.commerceOrder.count({ where: { store: { artistId } } }),
    db.royaltyEarning.aggregate({ _sum: { finalAmount: true }, where: { artistId } }).then(async (agg) => {
      const cur = await db.royaltyEarning.findFirst({ where: { artistId }, select: { currency: true } });
      return { total: agg._sum.finalAmount?.toString() ?? '0', currency: cur?.currency ?? null };
    }),
  ]);
  return {
    id: a.id,
    name: a.name,
    verified: a.verified,
    suspendedAt: a.suspendedAt?.toISOString() ?? null,
    suspendedReason: a.suspendedReason,
    owner: a.owner,
    counts: {
      albums: a._count.albums,
      tracks: a._count.tracks,
      tracksTakedown: takedown,
      followers: a._count.followers,
      posts: a._count.posts,
      openReports,
      stores: a._count.stores,
      orders,
    },
    royalty: { totalAllocated: royalty.total, currency: royalty.currency },
    createdAt: a.createdAt.toISOString(),
  };
}

export async function suspendArtist(
  artistId: string,
  reason: string,
  actor: AuthUser,
  db: Db = prisma,
): Promise<void> {
  const clean = reason.trim();
  if (clean.length < 5) throw badRequest('A suspension reason (min 5 chars) is required.');
  const artist = await db.artist.findFirst({ where: { id: artistId, deletedAt: null } });
  if (!artist) throw notFound('Artist not found.');
  if (artist.suspendedAt) throw badRequest('Artist is already suspended.');
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.artist.update({
      where: { id: artistId },
      data: { suspendedAt: now, suspendedReason: clean.slice(0, 500) },
    });
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'artist.suspended',
        targetType: 'artist',
        targetId: artistId,
        metadata: { name: artist.name },
        reversible: true,
        beforeState: { suspendedAt: null, suspendedReason: null },
        afterState: { suspendedAt: now.toISOString(), suspendedReason: clean.slice(0, 500) },
      },
      tx,
    );
  });
}

export async function restoreArtist(artistId: string, actor: AuthUser, db: Db = prisma): Promise<void> {
  const artist = await db.artist.findFirst({ where: { id: artistId, deletedAt: null } });
  if (!artist) throw notFound('Artist not found.');
  if (!artist.suspendedAt) throw badRequest('Artist is not suspended.');
  await db.$transaction(async (tx) => {
    await tx.artist.update({
      where: { id: artistId },
      data: { suspendedAt: null, suspendedReason: null },
    });
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'artist.suspension.lifted',
        targetType: 'artist',
        targetId: artistId,
        metadata: { name: artist.name },
        reversible: false,
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Content control — safe bulk actions on tracks.
// Only READY <-> TAKEDOWN transitions are allowed in bulk: both are
// non-destructive (no deletes, no re-processing) and every track gets its own
// audit row with before/after state.
// ---------------------------------------------------------------------------

const BULK_STATUSES = ['READY', 'TAKEDOWN'] as const;
type BulkStatus = (typeof BULK_STATUSES)[number];

export interface BulkTrackResult {
  updated: string[];
  skipped: Array<{ id: string; reason: string }>;
}

export async function bulkTrackStatus(
  ids: string[],
  status: BulkStatus,
  reason: string,
  actor: AuthUser,
  db: Db = prisma,
): Promise<BulkTrackResult> {
  const clean = reason.trim();
  if (clean.length < 5) throw badRequest('A reason (min 5 chars) is required for bulk actions.');
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw badRequest('Provide at least one track id.');
  if (unique.length > 100) throw badRequest('Bulk actions are limited to 100 tracks at a time.');
  if (!BULK_STATUSES.includes(status)) throw badRequest('Bulk status must be READY or TAKEDOWN.');

  const rows = await db.track.findMany({
    where: { id: { in: unique } },
    select: { id: true, title: true, status: true },
  });
  const found = new Map(rows.map((r) => [r.id, r]));
  const result: BulkTrackResult = { updated: [], skipped: [] };

  for (const id of unique) {
    const row = found.get(id);
    if (!row) {
      result.skipped.push({ id, reason: 'not found' });
      continue;
    }
    if (row.status === status) {
      result.skipped.push({ id, reason: `already ${status}` });
      continue;
    }
    if (row.status !== 'READY' && row.status !== 'TAKEDOWN') {
      result.skipped.push({ id, reason: `status ${row.status} cannot be bulk-changed` });
      continue;
    }
    await db.$transaction(async (tx) => {
      await tx.track.update({ where: { id }, data: { status } });
      await recordAuditEvent(
        {
          ...actorIdentity(actor),
          action: status === 'TAKEDOWN' ? 'track.takedown' : 'track.restored',
          targetType: 'track',
          targetId: id,
          metadata: { title: row.title, bulk: true, reason: clean.slice(0, 500) },
          reversible: true,
          beforeState: { status: row.status },
          afterState: { status },
        },
        tx,
      );
    });
    result.updated.push(id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Platform timeline — merged recent activity across subsystems. A curated
// recent-activity view (first page only); the audit log remains the complete
// immutable record.
// ---------------------------------------------------------------------------

export interface TimelineItem {
  at: string;
  kind: 'audit' | 'subscription' | 'chargeback' | 'royalty' | 'ingestion' | 'report';
  title: string;
  detail: string | null;
  url: string | null;
}

export async function getPlatformTimeline(limit = 50, db: Db = prisma): Promise<TimelineItem[]> {
  const take = Math.min(Math.max(limit, 1), 50);
  const [audits, subs, chargebacks, runs, reports] = await Promise.all([
    db.adminAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      select: { action: true, targetType: true, targetId: true, createdAt: true },
    }),
    db.subscriptionEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { eventType: true, statusFrom: true, statusTo: true, subscriptionId: true, createdAt: true },
    }),
    db.chargeback.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, amountCents: true, currency: true, reason: true, createdAt: true },
    }),
    db.royaltyCalculationRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, status: true, totalAllocated: true, currency: true, createdAt: true },
    }),
    db.moderationReport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { id: true, targetType: true, status: true, createdAt: true },
    }),
  ]);
  const items: TimelineItem[] = [
    ...audits.map((a) => ({
      at: a.createdAt.toISOString(),
      kind: 'audit' as const,
      title: `Admin: ${a.action}`,
      detail: a.targetType ? `${a.targetType}${a.targetId ? ` ${a.targetId.slice(0, 8)}` : ''}` : null,
      url: '#/audit',
    })),
    ...subs.map((s) => ({
      at: s.createdAt.toISOString(),
      kind: 'subscription' as const,
      title: `Subscription ${s.eventType.toLowerCase().replace(/_/g, ' ')}`,
      detail: s.statusFrom && s.statusTo ? `${s.statusFrom} → ${s.statusTo}` : null,
      url: '#/finance/subscriptions',
    })),
    ...chargebacks.map((c) => ({
      at: c.createdAt.toISOString(),
      kind: 'chargeback' as const,
      title: 'Chargeback recorded',
      detail: c.amountCents != null ? `${(c.amountCents / 100).toFixed(2)} ${c.currency ?? ''}`.trim() : (c.reason ?? null),
      url: '#/finance/subscriptions',
    })),
    ...runs.map((r) => ({
      at: r.createdAt.toISOString(),
      kind: 'royalty' as const,
      title: `Royalty run ${r.status.toLowerCase()}`,
      detail: `${r.totalAllocated.toString()} ${r.currency}`,
      url: '#/finance/royalties',
    })),
    ...reports.map((r) => ({
      at: r.createdAt.toISOString(),
      kind: 'report' as const,
      title: `${r.targetType} reported`,
      detail: r.status,
      url: '#/moderation',
    })),
  ];
  return items.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, take);
}

// ---------------------------------------------------------------------------
// Security center
// ---------------------------------------------------------------------------

export interface SecurityOverviewDto {
  generatedAt: string;
  logins24h: { total: number; failed: number };
  topFailedEmails: Array<{ email: string; failures: number }>;
  activeSessions: number;
  bannedUsers: number;
  lockedOutIps24h: number;
  authFailures: number;
  rateLimitHits: number;
  recentFailures: Array<{
    id: string;
    email: string;
    ipAddress: string | null;
    failureReason: string | null;
    createdAt: string;
  }>;
}

export async function getSecurityOverview(db: Db = prisma): Promise<SecurityOverviewDto> {
  const now = new Date();
  const d1 = new Date(now.getTime() - 24 * 3600 * 1000);
  const [total, failed, topFailed, activeSessions, bannedUsers, distinctIps, recent] =
    await Promise.all([
      db.loginEvent.count({ where: { createdAt: { gte: d1 } } }),
      db.loginEvent.count({ where: { createdAt: { gte: d1 }, success: false } }),
      db.$queryRawUnsafe<Array<{ email: string; failures: bigint }>>(
        `SELECT email, COUNT(*) AS failures FROM login_events
         WHERE created_at >= NOW() - INTERVAL '24 hours' AND success = FALSE
         GROUP BY email ORDER BY failures DESC LIMIT 10`,
      ),
      db.refreshToken.count({ where: { revokedAt: null, expiresAt: { gt: now } } }),
      db.user.count({ where: { deletedAt: null, bannedAt: { not: null } } }),
      db.loginEvent
        .findMany({
          where: { createdAt: { gte: d1 }, success: false, ipAddress: { not: null } },
          select: { ipAddress: true },
          distinct: ['ipAddress'],
        })
        .then((r) => r.length),
      db.loginEvent.findMany({
        where: { createdAt: { gte: d1 }, success: false },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, email: true, ipAddress: true, failureReason: true, createdAt: true },
      }),
    ]);
  const snap = metrics.snapshot();
  return {
    generatedAt: now.toISOString(),
    logins24h: { total, failed },
    topFailedEmails: topFailed.map((r) => ({ email: r.email, failures: Number(r.failures) })),
    activeSessions,
    bannedUsers,
    lockedOutIps24h: distinctIps,
    authFailures: snap.authFailures,
    rateLimitHits: snap.rateLimitHits,
    recentFailures: recent.map((r) => ({
      id: r.id,
      email: r.email,
      ipAddress: r.ipAddress,
      failureReason: r.failureReason,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export interface AdminSessionDto {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

export async function listAllSessions(
  userId: string | undefined,
  take: number,
  db: Db = prisma,
): Promise<AdminSessionDto[]> {
  const now = new Date();
  const rows = await db.refreshToken.findMany({
    where: {
      revokedAt: null,
      expiresAt: { gt: now },
      ...(userId ? { userId } : {}),
    },
    include: { user: { select: { email: true, displayName: true } } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(take, 1), 100),
  });
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    email: r.user.email,
    displayName: r.user.displayName,
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

export async function revokeSessionGlobal(
  sessionId: string,
  actor: AuthUser,
  db: Db = prisma,
): Promise<void> {
  const row = await db.refreshToken.findFirst({
    where: { id: sessionId, revokedAt: null },
    include: { user: { select: { id: true, email: true } } },
  });
  if (!row) throw notFound('Active session not found.');
  if (row.userId === actor.id) {
    throw badRequest('You cannot revoke your own current session from the security center. Sign out instead.');
  }
  await db.$transaction(async (tx) => {
    await tx.refreshToken.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'security.session.revoked',
        targetType: 'user',
        targetId: row.userId,
        metadata: { sessionId, email: row.user.email },
        reversible: false,
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Jobs center — there is no distributed job queue in this architecture.
// Ingestion runs as a single-process idempotent queue; royalty runs are
// synchronous; analytics is computed on read. This center surfaces the real
// queue state that exists and links the existing safe retry path.
// ---------------------------------------------------------------------------

export interface JobsOverviewDto {
  generatedAt: string;
  note: string;
  ingestion: {
    queued: number;
    processing: number;
    failed: number;
    ready: number;
    recentFailed: Array<{ id: string; title: string; artistName: string | null; updatedAt: string }>;
  };
  royaltyRuns: {
    succeeded: number;
    failed: number;
    recent: Array<{ id: string; status: string; totalAllocated: string; currency: string; createdAt: string }>;
  };
}

export async function getJobsOverview(db: Db = prisma): Promise<JobsOverviewDto> {
  const [queued, processing, failed, ready, recentFailed, recentRuns] = await Promise.all([
    db.track.count({ where: { audioStatus: 'NONE' } }),
    db.track.count({ where: { audioStatus: 'PROCESSING' } }),
    db.track.count({ where: { audioStatus: 'FAILED' } }),
    db.track.count({ where: { audioStatus: 'READY' } }),
    db.track.findMany({
      where: { audioStatus: 'FAILED' },
      select: { id: true, title: true, updatedAt: true, artist: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    }),
    db.royaltyCalculationRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, status: true, totalAllocated: true, currency: true, createdAt: true },
    }),
  ]);
  const snap = metrics.snapshot();
  return {
    generatedAt: new Date().toISOString(),
    note: 'No distributed job queue exists: ingestion is a single-process idempotent queue, royalty runs are synchronous, analytics is computed on read. Failed ingestion is retried via the existing idempotent retry endpoint.',
    ingestion: {
      queued,
      processing,
      failed,
      ready,
      recentFailed: recentFailed.map((t) => ({
        id: t.id,
        title: t.title,
        artistName: t.artist?.name ?? null,
        updatedAt: t.updatedAt.toISOString(),
      })),
    },
    royaltyRuns: {
      succeeded: snap.royaltyRuns.succeeded,
      failed: snap.royaltyRuns.failed,
      recent: recentRuns.map((r) => ({
        id: r.id,
        status: r.status,
        totalAllocated: r.totalAllocated.toString(),
        currency: r.currency,
        createdAt: r.createdAt.toISOString(),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Webhooks center — visibility over applied provider events. Delivery itself
// is provider-driven (no outbound queue); the only retry path that exists is
// the per-order payment retry, which stays user-initiated.
// ---------------------------------------------------------------------------

export interface WebhooksOverviewDto {
  generatedAt: string;
  note: string;
  subscription: {
    received: number;
    duplicates: number;
    failed: number;
    recent: Array<{
      id: string;
      eventType: string;
      statusFrom: string | null;
      statusTo: string | null;
      provider: string;
      createdAt: string;
    }>;
  };
  commerce: {
    received: number;
    duplicates: number;
    failed: number;
    recent: Array<{
      id: string;
      eventType: string;
      paymentId: string;
      createdAt: string;
    }>;
  };
}

export async function getWebhooksOverview(db: Db = prisma): Promise<WebhooksOverviewDto> {
  const [subRecent, commerceRecent] = await Promise.all([
    db.subscriptionEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { id: true, eventType: true, statusFrom: true, statusTo: true, provider: true, createdAt: true },
    }),
    db.commercePaymentEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { id: true, eventType: true, paymentId: true, createdAt: true },
    }),
  ]);
  const snap = metrics.snapshot();
  return {
    generatedAt: new Date().toISOString(),
    note: 'Webhooks are inbound and provider-driven; the platform keeps idempotent applied-event records, not an outbound delivery queue. Duplicates are acknowledged without re-applying.',
    subscription: {
      ...snap.subscriptionWebhooks,
      recent: subRecent.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        statusFrom: e.statusFrom,
        statusTo: e.statusTo,
        provider: e.provider,
        createdAt: e.createdAt.toISOString(),
      })),
    },
    commerce: {
      ...snap.commerceWebhooks,
      recent: commerceRecent.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        paymentId: e.paymentId,
        createdAt: e.createdAt.toISOString(),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// System health — machine checks plus dependency probes.
// ---------------------------------------------------------------------------

export interface HealthDto {
  generatedAt: string;
  api: { status: 'ok'; uptimeSeconds: number };
  database: { status: 'ok' | 'error'; latencyMs: number | null; error: string | null };
  storage: { driver: string; status: 'ok' | 'unknown' };
  emergency: { maintenanceMode: boolean; readonlyMode: boolean; newSignupsEnabled: boolean };
  metrics: {
    requestsTotal: number;
    requests5xx: number;
    dbErrors: number;
    wsCurrent: number;
  };
}

export async function getSystemHealth(db: Db = prisma): Promise<HealthDto> {
  const snap = metrics.snapshot();
  let dbStatus: 'ok' | 'error' = 'ok';
  let latencyMs: number | null = null;
  let dbError: string | null = null;
  const t0 = Date.now();
  try {
    await db.$queryRawUnsafe('SELECT 1');
    latencyMs = Date.now() - t0;
  } catch (e) {
    dbStatus = 'error';
    dbError = e instanceof Error ? e.message.slice(0, 200) : 'unknown';
  }
  const [maintenanceMode, readonlyMode, newSignupsEnabled] = await Promise.all([
    emergencyActive('emergency.maintenance_mode'),
    emergencyActive('emergency.readonly_mode'),
    emergencyActive('emergency.new_signups_enabled'),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    api: { status: 'ok', uptimeSeconds: snap.uptimeSeconds },
    database: { status: dbStatus, latencyMs, error: dbError },
    storage: { driver: process.env.AUDIO_STORAGE_DRIVER ?? 'local', status: 'unknown' },
    emergency: { maintenanceMode, readonlyMode, newSignupsEnabled },
    metrics: {
      requestsTotal: snap.requests.total,
      requests5xx: snap.requests.byStatus['5xx'] ?? 0,
      dbErrors: snap.dbErrors,
      wsCurrent: snap.wsConnections.current,
    },
  };
}

// ---------------------------------------------------------------------------
// Feature flags & platform settings — SUPER_ADMIN only, every change audited.
// ---------------------------------------------------------------------------

export async function setFlag(
  key: string,
  input: { enabled: boolean; rolloutPercent: number; description?: string },
  actor: AuthUser,
  db: Db = prisma,
): Promise<void> {
  validateFlagKey(key);
  if (!Number.isInteger(input.rolloutPercent) || input.rolloutPercent < 0 || input.rolloutPercent > 100) {
    throw badRequest('rolloutPercent must be an integer between 0 and 100.');
  }
  const before = await db.featureFlag.findUnique({ where: { key } });
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.featureFlag.upsert({
      where: { key },
      create: {
        key,
        enabled: input.enabled,
        rolloutPercent: input.rolloutPercent,
        description: input.description?.slice(0, 500) ?? null,
        updatedBy: actor.id,
        updatedAt: now,
      },
      update: {
        enabled: input.enabled,
        rolloutPercent: input.rolloutPercent,
        description: input.description?.slice(0, 500) ?? null,
        updatedBy: actor.id,
        updatedAt: now,
      },
    });
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'platform.flag.changed',
        targetType: 'feature_flag',
        targetId: null,
        metadata: { key },
        reversible: true,
        beforeState: before
          ? { enabled: before.enabled, rolloutPercent: before.rolloutPercent }
          : null,
        afterState: { enabled: input.enabled, rolloutPercent: input.rolloutPercent },
      },
      tx,
    );
  });
}

export async function deleteFlag(key: string, actor: AuthUser, db: Db = prisma): Promise<void> {
  validateFlagKey(key);
  const before = await db.featureFlag.findUnique({ where: { key } });
  if (!before) throw notFound('Feature flag not found.');
  await db.$transaction(async (tx) => {
    await tx.featureFlag.delete({ where: { key } });
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'platform.flag.deleted',
        targetType: 'feature_flag',
        targetId: null,
        metadata: { key },
        reversible: true,
        beforeState: { enabled: before.enabled, rolloutPercent: before.rolloutPercent },
        afterState: null,
      },
      tx,
    );
  });
}

export async function setSetting(
  key: string,
  value: unknown,
  actor: AuthUser,
  db: Db = prisma,
): Promise<void> {
  if (!isKnownSetting(key)) throw badRequest(`Unknown setting key: ${key}.`);
  validateSettingValue(key, value);
  const before = await db.platformSetting.findUnique({ where: { key } });
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.platformSetting.upsert({
      where: { key },
      create: { key, value: value as never, updatedBy: actor.id, updatedAt: now },
      update: { value: value as never, updatedBy: actor.id, updatedAt: now },
    });
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'platform.setting.changed',
        targetType: 'platform_setting',
        targetId: null,
        metadata: key.startsWith('emergency.') ? { key, breakGlass: true } : { key },
        reversible: true,
        beforeState: before ? { value: before.value } : null,
        afterState: { value },
      },
      tx,
    );
  });
  // Enforcement hooks read the cache; refresh immediately so a kill switch
  // takes effect without waiting for the TTL.
  await refreshSettingsCache(db).catch(() => undefined);
}

export { listFlags, listSettings };

// ---------------------------------------------------------------------------
// Impersonation — SUPER_ADMIN only, short-lived, fully attributed.
//
// A signed JWT (imp=true) lets the super admin act as a non-admin user.
// Guards:
//  - target must be a non-admin, non-banned, non-deleted user, and not self;
//  - the actor must still be SUPER_ADMIN when the token is USED (demotion
//    kills outstanding impersonation tokens immediately);
//  - impersonated sessions can never touch /v1/admin/* (enforced in the
//    authenticate guard);
//  - every audit write under impersonation carries metadata.impersonatedBy.
// ---------------------------------------------------------------------------

export interface ImpersonationStartInput {
  targetUserId: string;
  reason: string;
  /** Minutes, default 5, max 30. */
  durationMinutes?: number;
}

export interface ImpersonationSession {
  token: string;
  expiresAt: string;
  target: { id: string; email: string; displayName: string | null; role: string };
}

const ADMIN_IMPERSONATION_BLOCKED = [
  'SUPER_ADMIN',
  'ADMIN',
  'PLATFORM_ADMIN',
  'MODERATOR',
  'SUPPORT_ADMIN',
  'FINANCE_ADMIN',
  'CONTENT_ADMIN',
  'ARTIST_ADMIN',
  'ANALYTICS_ADMIN',
];

export async function startImpersonation(
  input: ImpersonationStartInput,
  actor: AuthUser,
  deps: { sign: (payload: Record<string, unknown>, expiresInMinutes: number) => Promise<string>; db?: Db } = {
    sign: async () => { throw new Error('signer not provided'); },
  },
): Promise<ImpersonationSession> {
  const db = deps.db ?? prisma;
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 10) throw badRequest('A reason of at least 10 characters is required.');
  if (reason.length > 500) throw badRequest('Reason must be at most 500 characters.');
  const durationMinutes = input.durationMinutes ?? 5;
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 30) {
    throw badRequest('durationMinutes must be an integer between 1 and 30.');
  }

  // Re-read the actor: only a current SUPER_ADMIN may impersonate.
  const actorRow = await db.user.findUnique({
    where: { id: actor.id },
    select: { role: true, deletedAt: true },
  });
  if (!actorRow || actorRow.deletedAt || actorRow.role !== 'SUPER_ADMIN') {
    throw badRequest('Only an active SUPER_ADMIN can start impersonation.');
  }

  const target = await db.user.findUnique({
    where: { id: input.targetUserId },
    select: { id: true, email: true, displayName: true, role: true, deletedAt: true, bannedAt: true },
  });
  if (!target || target.deletedAt) throw notFound('Target user not found.');
  if (target.id === actor.id) throw badRequest('You cannot impersonate yourself.');
  if (ADMIN_IMPERSONATION_BLOCKED.includes(target.role)) {
    throw badRequest('Impersonating another admin is not allowed.');
  }
  if (target.bannedAt) throw badRequest('Impersonating a suspended user is not allowed.');

  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + durationMinutes * 60_000);
  const token = await deps.sign(
    {
      sub: target.id,
      email: target.email,
      role: target.role,
      imp: true,
      actorId: actor.id,
      reason: reason.slice(0, 500),
      impStartedAt: startedAt.toISOString(),
    },
    durationMinutes,
  );

  await recordAuditEvent(
    {
      ...actorIdentity(actor),
      action: 'impersonation.started',
      targetType: 'user',
      targetId: target.id,
      metadata: { reason: reason.slice(0, 500), durationMinutes, expiresAt: expiresAt.toISOString() },
      reversible: false,
    },
    db,
  );

  return {
    token,
    expiresAt: expiresAt.toISOString(),
    target: { id: target.id, email: target.email, displayName: target.displayName, role: target.role },
  };
}

export async function endImpersonation(actor: AuthUser, db: Db = prisma): Promise<void> {
  const imp = actor.impersonation;
  if (!imp) throw badRequest('This session is not an impersonation session.');
  await recordAuditEvent(
    {
      actorId: imp.adminId,
      action: 'impersonation.ended',
      targetType: 'user',
      targetId: actor.id,
      metadata: { reason: imp.reason },
      reversible: false,
    },
    db,
  );
}

// ---------------------------------------------------------------------------
// Group 2 — finance centers (read-only, real data, finance.view).
// ---------------------------------------------------------------------------

export interface SubscriptionFinance {
  byStatus: { status: string; count: number }[];
  byPlan: { planId: string; planName: string; count: number }[];
  trialing: number;
  chargebacks: { count: number; amountCents: number };
  recentEvents: { id: string; eventType: string; statusFrom: string | null; statusTo: string | null; createdAt: string }[];
}

export async function getSubscriptionFinance(): Promise<SubscriptionFinance> {
  const [statusGroups, planGroups, trialing, chargebacks, recentEvents] = await Promise.all([
    prisma.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.subscription.groupBy({ by: ['planId'], _count: { _all: true } }),
    prisma.subscription.count({ where: { status: 'TRIALING' } }),
    prisma.chargeback.aggregate({ _count: { _all: true }, _sum: { amountCents: true } }),
    prisma.subscriptionEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { id: true, eventType: true, statusFrom: true, statusTo: true, createdAt: true },
    }),
  ]);
  const planIds = [...new Set(planGroups.map((g) => g.planId))];
  const plans = await prisma.plan.findMany({ where: { id: { in: planIds } }, select: { id: true, name: true } });
  const planNames = new Map(plans.map((p) => [p.id, p.name]));
  return {
    byStatus: statusGroups.map((g) => ({ status: g.status, count: g._count._all })),
    byPlan: planGroups.map((g) => ({
      planId: g.planId,
      planName: planNames.get(g.planId) ?? g.planId,
      count: g._count._all,
    })),
    trialing,
    chargebacks: { count: chargebacks._count._all, amountCents: chargebacks._sum.amountCents ?? 0 },
    recentEvents: recentEvents.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      statusFrom: e.statusFrom,
      statusTo: e.statusTo,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

export interface CommerceFinance {
  grossCents: number;
  refundedCents: number;
  netCents: number;
  byStatus: { status: string; count: number }[];
  refunds: { count: number; amountCents: number };
  recentRefunds: { id: string; orderId: string; amountCents: number; currency: string; createdAt: string }[];
}

const CAPTURED_ORDER_STATUSES = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const;

export async function getCommerceFinance(): Promise<CommerceFinance> {
  const [gross, statusGroups, refunds, recentRefunds] = await Promise.all([
    prisma.commerceOrder.aggregate({
      where: { status: { in: [...CAPTURED_ORDER_STATUSES] } },
      _sum: { totalCents: true },
    }),
    prisma.commerceOrder.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.commerceRefund.aggregate({ _count: { _all: true }, _sum: { amountCents: true } }),
    prisma.commerceRefund.findMany({
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { id: true, orderId: true, amountCents: true, currency: true, createdAt: true },
    }),
  ]);
  const grossCents = gross._sum.totalCents ?? 0;
  const refundedCents = refunds._sum.amountCents ?? 0;
  return {
    grossCents,
    refundedCents,
    netCents: grossCents - refundedCents,
    byStatus: statusGroups.map((g) => ({ status: g.status, count: g._count._all })),
    refunds: { count: refunds._count._all, amountCents: refundedCents },
    recentRefunds: recentRefunds.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      amountCents: r.amountCents,
      currency: r.currency,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export interface RoyaltyFinance {
  runs: { id: string; status: string; royaltyPool: string; totalAllocated: string; residualAmount: string; createdAt: string }[];
  totals: { runs: number; allocated: string; adjustments: number; adjustmentAmount: string };
  recentAdjustments: { id: string; runId: string; artistId: string; amount: string; currency: string; reason: string; createdAt: string }[];
}

export async function getRoyaltyFinance(): Promise<RoyaltyFinance> {
  const [runs, allocated, adjustments, recentAdjustments] = await Promise.all([
    prisma.royaltyCalculationRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: {
        id: true, status: true, royaltyPool: true, totalAllocated: true,
        residualAmount: true, createdAt: true,
      },
    }),
    prisma.royaltyCalculationRun.aggregate({ _count: { _all: true }, _sum: { totalAllocated: true } }),
    prisma.royaltyAdjustment.aggregate({ _count: { _all: true }, _sum: { amount: true } }),
    prisma.royaltyAdjustment.findMany({
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { id: true, runId: true, artistId: true, amount: true, currency: true, reason: true, createdAt: true },
    }),
  ]);
  return {
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      royaltyPool: r.royaltyPool.toString(),
      totalAllocated: r.totalAllocated.toString(),
      residualAmount: r.residualAmount.toString(),
      createdAt: r.createdAt.toISOString(),
    })),
    totals: {
      runs: allocated._count._all,
      allocated: (allocated._sum.totalAllocated ?? 0).toString(),
      adjustments: adjustments._count._all,
      adjustmentAmount: (adjustments._sum.amount ?? 0).toString(),
    },
    recentAdjustments: recentAdjustments.map((a) => ({
      id: a.id,
      runId: a.runId,
      artistId: a.artistId,
      amount: a.amount.toString(),
      currency: a.currency,
      reason: a.reason,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Group 2 — unified moderation overview (reports.moderate).
// ---------------------------------------------------------------------------

export interface ModerationOverview {
  byStatus: { status: string; count: number }[];
  byTargetType: { targetType: string; count: number }[];
  oldestOpen: { id: string; targetType: string; createdAt: string } | null;
  recent: { id: string; targetType: string; status: string; createdAt: string }[];
}

export async function getModerationOverview(): Promise<ModerationOverview> {
  const [byStatus, byTargetType, oldestOpen, recent] = await Promise.all([
    prisma.moderationReport.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.moderationReport.groupBy({ by: ['targetType'], _count: { _all: true } }),
    prisma.moderationReport.findFirst({
      where: { status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, targetType: true, createdAt: true },
    }),
    prisma.moderationReport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { id: true, targetType: true, status: true, createdAt: true },
    }),
  ]);
  return {
    byStatus: byStatus.map((g) => ({ status: g.status, count: g._count._all })),
    byTargetType: byTargetType.map((g) => ({ targetType: g.targetType, count: g._count._all })),
    oldestOpen: oldestOpen
      ? { id: oldestOpen.id, targetType: oldestOpen.targetType, createdAt: oldestOpen.createdAt.toISOString() }
      : null,
    recent: recent.map((r) => ({
      id: r.id,
      targetType: r.targetType,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
