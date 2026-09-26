// Phase 25 — offline downloads. Server-minted download authorizations.
//
// A download authorization is a grant DISTINCT from playback sessions
// (ADR-019). It binds an authenticated user to a track at a pinned audio
// version, with two separate lifetimes:
// - downloadTokenExpiresAt: short window for the opaque delivery token
//   that fetches HLS segments. Hash stored, raw token shown once.
// - expiresAt: the offline entitlement window (default 30 days). Offline
//   playback is allowed only inside [issuedAt, expiresAt]; the window
//   slides forward on successful server-side revalidation while the user
//   stays entitled. The client can never extend it.
//
// Offline play events uploaded later attach to a synthetic server-side
// playback session per offlineSessionKey (sessionId stays non-null) and
// are validated for ownership, window containment, and sequence
// plausibility.

import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient, PlayEventType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import type { Config } from '../../config.js';
import {
  badRequest,
  conflict,
  notFound,
  subscriptionRequired,
  unauthorized,
} from '../../http/errors.js';
import { getEntitlement } from '../subscriptions/entitlements.js';
import { checkPlaybackEntitlement } from '../streaming/entitlements.js';
import { metrics } from '../../http/metrics.js';
import { masterKey, type AudioStorage } from '../streaming/storage.js';

export interface OfflineDeps {
  db: PrismaClient;
  config: Config;
  storage: AudioStorage;
}

export interface AuthorizeDownloadResult {
  authorizationId: string;
  /** Opaque delivery token. Shown to the client exactly once. */
  token: string;
  downloadTokenExpiresAt: Date;
  expiresAt: Date;
  audioVersion: number;
  track: {
    id: string;
    title: string;
    artistName: string;
    albumTitle: string | null;
    durationMs: number;
  };
  /** Token-scoped master playlist URL for the download. Dies with the token. */
  downloadUrl: string;
}

export interface ResolvedDownloadToken {
  authorizationId: string;
  userId: string;
  trackId: string;
  audioVersion: number;
}

export type RevalidationStatus =
  | 'ok'
  | 'expired'
  | 'revoked'
  | 'version_mismatch'
  | 'entitlement_lost'
  | 'entitlement_canceled'
  | 'track_unavailable';

export interface RevalidationResult {
  valid: boolean;
  status: RevalidationStatus;
  expiresAt: Date;
  /** Audio version pinned on the authorization. */
  audioVersion: number;
  /** Current audio version of the track (lets the client detect staleness). */
  currentAudioVersion: number | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function downloadBasePath(): string {
  return '/v1/offline/downloads';
}

interface DownloadableTrack {
  id: string;
  audioVersion: number;
  title: string;
  artistName: string;
  albumTitle: string | null;
  durationMs: number;
}

/**
 * Track availability for download: the track must exist, not be
 * soft-deleted, and be in READY status. TAKEDOWN / deleted / non-READY
 * are client-visible errors, never silent. Source audio is never touched:
 * downloads use the published HLS package only.
 */
async function requireDownloadableTrack(
  trackId: string,
  db: PrismaClient,
): Promise<DownloadableTrack> {
  const track = await db.track.findFirst({
    where: { id: trackId, deletedAt: null },
    select: {
      id: true,
      status: true,
      audioVersion: true,
      title: true,
      durationMs: true,
      album: { select: { title: true } },
      artist: { select: { name: true } },
    },
  });
  if (!track) {
    throw notFound('Track not found.');
  }
  if (track.status !== 'READY') {
    throw conflict(`Track is not available for download (status: ${track.status}).`);
  }
  return {
    id: track.id,
    audioVersion: track.audioVersion,
    title: track.title,
    artistName: track.artist.name,
    albumTitle: track.album?.title ?? null,
    durationMs: track.durationMs,
  };
}

/**
 * Authorize a download: availability → entitlement → grant issuance.
 * Idempotent per (user, track): a live authorization for the current
 * audio version is reused (delivery token rotated); a stale one is
 * refreshed in place. Throws HttpProblem errors rendered as RFC 7807.
 */
export async function authorizeDownload(
  userId: string,
  trackId: string,
  deps: OfflineDeps,
): Promise<AuthorizeDownloadResult> {
  const { db, config, storage } = deps;

  const track = await requireDownloadableTrack(trackId, db);

  // LISTENERs without entitlement cannot authorize downloads. The decision
  // is derived from authoritative subscription state; no client-provided
  // premium flag is ever consulted.
  const entitlement = await checkPlaybackEntitlement({ userId, trackId: track.id, db });
  if (!entitlement.allowed) {
    throw subscriptionRequired(
      `Offline downloads require an eligible subscription (${entitlement.reason}).`,
    );
  }

  // The catalog says READY but the HLS package must actually be present.
  if (!(await storage.exists(masterKey(track.id)))) {
    throw conflict('Audio is not available for this track yet.');
  }

  const now = new Date();
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const downloadTokenExpiresAt = new Date(
    now.getTime() + config.offline.downloadTokenTtlSeconds * 1000,
  );

  const existing = await db.offlineDownloadAuthorization.findUnique({
    where: { userId_trackId: { userId, trackId: track.id } },
  });

  let authorizationId: string;
  let expiresAt: Date;
  if (
    existing &&
    existing.revokedAt === null &&
    existing.expiresAt.getTime() > now.getTime() &&
    existing.audioVersion === track.audioVersion
  ) {
    // Live grant for the current version: rotate the delivery token only.
    // The entitlement window is NOT extended here — only revalidation
    // extends it, and only while the user stays entitled.
    const updated = await db.offlineDownloadAuthorization.update({
      where: { id: existing.id },
      data: { tokenHash, downloadTokenExpiresAt, lastValidatedAt: now },
      select: { id: true, expiresAt: true },
    });
    authorizationId = updated.id;
    expiresAt = updated.expiresAt;
  } else {
    // New or stale grant: (re)start the full entitlement window. A stale
    // row is updated in place to preserve the unique (userId, trackId)
    // invariant and to clear any prior revocation.
    expiresAt = new Date(now.getTime() + config.offline.authorizationTtlSeconds * 1000);
    const data = {
      userId,
      trackId: track.id,
      audioVersion: track.audioVersion,
      tokenHash,
      downloadTokenExpiresAt,
      issuedAt: now,
      expiresAt,
      revokedAt: null,
      lastValidatedAt: now,
    };
    const row = existing
      ? await db.offlineDownloadAuthorization.update({
          where: { id: existing.id },
          data,
          select: { id: true },
        })
      : await db.offlineDownloadAuthorization.create({
          data,
          select: { id: true },
        });
    authorizationId = row.id;
  }

  // Phase 32 — observability: count successful download authorizations.
  metrics.recordDownloadAuthorization();

  return {
    authorizationId,
    token,
    downloadTokenExpiresAt,
    expiresAt,
    audioVersion: track.audioVersion,
    track: {
      id: track.id,
      title: track.title,
      artistName: track.artistName,
      albumTitle: track.albumTitle,
      durationMs: track.durationMs,
    },
    downloadUrl: `${downloadBasePath()}/hls/master.m3u8?token=${token}`,
  };
}

/**
 * Validate a download token for manifest/segment delivery. Invalid,
 * expired, and revoked tokens are indistinguishable to the caller (all
 * 401) so tokens cannot be probed. The track's CURRENT streamability is
 * re-checked: a TAKEDOWN mid-download fails the remaining fetches.
 */
export async function resolveDownloadToken(
  token: string,
  deps: Pick<OfflineDeps, 'db'>,
): Promise<ResolvedDownloadToken> {
  const auth = await deps.db.offlineDownloadAuthorization.findFirst({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      userId: true,
      trackId: true,
      audioVersion: true,
      revokedAt: true,
      downloadTokenExpiresAt: true,
      track: { select: { status: true, deletedAt: true } },
    },
  });
  if (!auth || auth.revokedAt !== null || auth.downloadTokenExpiresAt.getTime() <= Date.now()) {
    throw unauthorized('Download authorization is invalid or has expired.');
  }
  if (!auth.track || auth.track.deletedAt !== null || auth.track.status !== 'READY') {
    throw conflict('Track is no longer available for download.');
  }
  return {
    authorizationId: auth.id,
    userId: auth.userId,
    trackId: auth.trackId,
    audioVersion: auth.audioVersion,
  };
}

/**
 * Revalidate an offline authorization while the app has network.
 * Owner-scoped: other users' ids read as 404 (no existence leak).
 *
 * Fail-closed subscription semantics (ADR-014 / Phase 18):
 * - ACTIVE/TRIALING (valid): extend the window (sliding), valid=true.
 * - CANCELED: deny new downloads elsewhere; here the existing window is
 *   respected but NOT extended.
 * - PAST_DUE / EXPIRED / REVOKED / no subscription: revoke the grant.
 * - Track TAKEDOWN/deleted: revoke the grant.
 * - Audio version mismatch: do not revoke; the client re-authorizes,
 *   which refreshes the row to the new version.
 */
export async function revalidateAuthorization(
  authorizationId: string,
  userId: string,
  deps: Pick<OfflineDeps, 'db' | 'config'>,
): Promise<RevalidationResult> {
  const { db, config } = deps;
  const now = new Date();

  const auth = await db.offlineDownloadAuthorization.findFirst({
    where: { id: authorizationId, userId },
    select: {
      id: true,
      audioVersion: true,
      expiresAt: true,
      revokedAt: true,
      track: { select: { id: true, status: true, deletedAt: true, audioVersion: true } },
    },
  });
  if (!auth) {
    throw notFound('Download authorization not found.');
  }

  const base = {
    expiresAt: auth.expiresAt,
    audioVersion: auth.audioVersion,
    currentAudioVersion: auth.track?.audioVersion ?? null,
  };

  if (auth.revokedAt !== null) {
    return { valid: false, status: 'revoked', ...base };
  }

  const trackGone = !auth.track || auth.track.deletedAt !== null || auth.track.status !== 'READY';
  if (trackGone) {
    await db.offlineDownloadAuthorization.update({
      where: { id: auth.id },
      data: { revokedAt: now, lastValidatedAt: now },
    });
    return { valid: false, status: 'track_unavailable', ...base };
  }

  if (auth.track.audioVersion !== auth.audioVersion) {
    await db.offlineDownloadAuthorization.update({
      where: { id: auth.id },
      data: { lastValidatedAt: now },
    });
    return { valid: false, status: 'version_mismatch', ...base };
  }

  if (auth.expiresAt.getTime() <= now.getTime()) {
    return { valid: false, status: 'expired', ...base };
  }

  const entitlement = await getEntitlement(userId, db, now);
  if (!entitlement.entitled) {
    // CANCELED: the paid window may still have time left per the brief —
    // respect the existing expiry, but never extend it.
    if (entitlement.status === 'CANCELED') {
      await db.offlineDownloadAuthorization.update({
        where: { id: auth.id },
        data: { lastValidatedAt: now },
      });
      return { valid: true, status: 'entitlement_canceled', ...base };
    }
    // PAST_DUE / EXPIRED / REVOKED / none: fail closed — revoke now.
    await db.offlineDownloadAuthorization.update({
      where: { id: auth.id },
      data: { revokedAt: now, lastValidatedAt: now },
    });
    return { valid: false, status: 'entitlement_lost', ...base };
  }

  // Entitled and everything checks out: slide the window forward.
  const expiresAt = new Date(now.getTime() + config.offline.authorizationTtlSeconds * 1000);
  await db.offlineDownloadAuthorization.update({
    where: { id: auth.id },
    data: { expiresAt, lastValidatedAt: now },
  });
  return { valid: true, status: 'ok', ...base, expiresAt };
}

/** Explicit revocation (e.g. user removes the download while online). */
export async function revokeAuthorization(
  authorizationId: string,
  userId: string,
  db: PrismaClient = prisma,
): Promise<{ id: string; revokedAt: Date }> {
  const auth = await db.offlineDownloadAuthorization.findFirst({
    where: { id: authorizationId, userId },
    select: { id: true },
  });
  if (!auth) {
    throw notFound('Download authorization not found.');
  }
  const revokedAt = new Date();
  await db.offlineDownloadAuthorization.update({
    where: { id: auth.id },
    data: { revokedAt },
  });
  return { id: auth.id, revokedAt };
}

// --- Offline play-event sync ------------------------------------------------

export type OfflinePlayEventType = PlayEventType;

export interface OfflineEventInput {
  /** Client-generated UUID. The idempotency key for retried uploads. */
  key: string;
  offlineAuthorizationId: string;
  /** Groups the events of one offline playback session (the stream unit). */
  offlineSessionKey: string;
  type: OfflinePlayEventType;
  positionMs?: number;
  /** When playback actually happened offline (ISO string from the client). */
  occurredAt: string;
}

export interface OfflineEventSyncResult {
  accepted: string[];
  rejected: { key: string; reason: string }[];
}

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // tolerate 5 min of client clock skew
/** End-of-track reporting overshoot tolerated past track.durationMs. */
const POSITION_TOLERANCE_MS = 30_000;

/**
 * Ingest offline play events. Each event is validated for ownership and
 * temporal consistency against its authorization window; accepted events
 * are appended to the same append-only play_events table as online events.
 * Uploads are idempotent per offlineEventKey: replayed keys are accepted
 * as duplicates without creating new rows.
 *
 * Honest limitation: the server verifies that an event *could* have
 * happened (right user, right track, inside the grant window), not that
 * playback physically occurred. Royalty/stream calculations stay
 * server-side and unchanged.
 */
/**
 * Ingest offline play events. Each event is validated for ownership,
 * authorization-window containment, and session-sequence plausibility;
 * accepted events are appended to the same append-only play_events table as
 * online events, attached to a synthetic server-side PlaybackSession created
 * per offlineSessionKey. That keeps sessionId non-null and Phase 15
 * session/stream/royalty analytics working unchanged for offline plays.
 *
 * createdAt is set from occurredAt (not upload time) so analytics bucket on
 * actual playback time. Uploads are idempotent per offlineEventKey: replayed
 * keys are reported accepted without creating new rows.
 *
 * Honest limitation: the server verifies that an event *could* have happened
 * (right user, right track, inside the grant window, plausible sequence),
 * not that playback physically occurred. Royalty/stream calculations stay
 * server-side and unchanged.
 */
export async function recordOfflineEvents(
  userId: string,
  events: OfflineEventInput[],
  deps: Pick<OfflineDeps, 'db'>,
): Promise<OfflineEventSyncResult> {
  const { db } = deps;
  const accepted: string[] = [];
  const rejected: { key: string; reason: string }[] = [];
  if (events.length === 0) {
    return { accepted, rejected };
  }
  if (events.length > 500) {
    throw badRequest('Too many events in one upload (max 500).');
  }

  const now = Date.now();
  const fail = (key: string, reason: string) => rejected.push({ key, reason });

  // -- authorizations + track durations -------------------------------------
  const authIds = [...new Set(events.map((e) => e.offlineAuthorizationId))];
  const auths = await db.offlineDownloadAuthorization.findMany({
    where: { id: { in: authIds } },
    select: {
      id: true,
      userId: true,
      trackId: true,
      issuedAt: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  const authById = new Map(auths.map((a) => [a.id, a]));
  const trackIds = [...new Set(auths.map((a) => a.trackId))];
  const tracks = await db.track.findMany({
    where: { id: { in: trackIds } },
    select: { id: true, durationMs: true },
  });
  const durationByTrackId = new Map(tracks.map((t) => [t.id, t.durationMs]));

  // -- idempotency: keys already stored --------------------------------------
  const keys = events.map((e) => e.key);
  const existing = await db.playEvent.findMany({
    where: { offlineEventKey: { in: keys } },
    select: { offlineEventKey: true },
  });
  const existingKeys = new Set(
    existing.map((e) => e.offlineEventKey).filter((k): k is string => k !== null),
  );

  interface CheckedEvent {
    input: OfflineEventInput;
    occurredMs: number;
    auth: (typeof auths)[number];
    durationMs: number;
  }

  // -- per-event basic validation --------------------------------------------
  const bySessionKey = new Map<string, CheckedEvent[]>();
  // Keys already carried by an earlier event in THIS upload. The key is the
  // event's identity: a repeat inside one batch is the same idempotent
  // retry the cross-batch existingKeys check handles, so it is accepted
  // without being validated (and inserted) twice.
  const batchKeys = new Set<string>();
  for (const event of events) {
    if (!event.key || typeof event.key !== 'string' || event.key.length > 64) {
      fail(event.key, 'invalid_event_key');
      continue;
    }
    if (existingKeys.has(event.key) || batchKeys.has(event.key)) {
      // Idempotent replay: already stored (or already carried by this
      // upload), count as accepted.
      accepted.push(event.key);
      continue;
    }
    if (!['START', 'HEARTBEAT', 'COMPLETE', 'ERROR'].includes(event.type)) {
      fail(event.key, 'invalid_event_type');
      continue;
    }
    if (
      event.positionMs !== undefined &&
      (!Number.isInteger(event.positionMs) || event.positionMs < 0)
    ) {
      fail(event.key, 'invalid_position');
      continue;
    }
    const occurredAt = new Date(event.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      fail(event.key, 'invalid_occurred_at');
      continue;
    }
    if (occurredAt.getTime() > now + MAX_CLOCK_SKEW_MS) {
      fail(event.key, 'occurred_at_in_future');
      continue;
    }
    if (
      !event.offlineSessionKey ||
      typeof event.offlineSessionKey !== 'string' ||
      event.offlineSessionKey.length > 64
    ) {
      fail(event.key, 'invalid_session_key');
      continue;
    }

    const auth = authById.get(event.offlineAuthorizationId);
    // No existence leak and no cross-user reuse: anything off reads as
    // "not found" for this caller.
    if (!auth || auth.userId !== userId) {
      fail(event.key, 'authorization_not_found');
      continue;
    }
    const occurredMs = occurredAt.getTime();
    if (occurredMs < auth.issuedAt.getTime() || occurredMs > auth.expiresAt.getTime()) {
      fail(event.key, 'outside_authorization_window');
      continue;
    }
    if (auth.revokedAt !== null && occurredMs > auth.revokedAt.getTime()) {
      fail(event.key, 'authorization_revoked');
      continue;
    }
    // Duration bound: a position past the track end (plus reporting
    // tolerance) cannot be genuine playback of this track.
    const durationMs = durationByTrackId.get(auth.trackId);
    if (durationMs === undefined) {
      fail(event.key, 'track_unavailable');
      continue;
    }
    if (event.positionMs !== undefined && event.positionMs > durationMs + POSITION_TOLERANCE_MS) {
      fail(event.key, 'position_out_of_bounds');
      continue;
    }

    const group = bySessionKey.get(event.offlineSessionKey) ?? [];
    group.push({ input: event, occurredMs, auth, durationMs });
    bySessionKey.set(event.offlineSessionKey, group);
    batchKeys.add(event.key);
  }

  // -- per-session sequence validation + synthetic session --------------------
  for (const [sessionKey, group] of bySessionKey) {
    // One authorization per offline session: a sessionKey reused across
    // tracks/authorizations is rejected.
    const groupAuthIds = new Set(group.map((g) => g.auth.id));
    if (groupAuthIds.size > 1) {
      for (const g of group) fail(g.input.key, 'session_authorization_mismatch');
      continue;
    }
    const auth = group[0].auth;

    // Existing state for this (user, sessionKey): prior events and the
    // synthetic session, if a previous upload already created them.
    const [storedEvents, storedSession] = await Promise.all([
      db.playEvent.findMany({
        where: { userId, offlineSessionKey: sessionKey },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
        select: { eventType: true, occurredAt: true },
      }),
      db.playbackSession.findUnique({
        where: { userId_offlineSessionKey: { userId, offlineSessionKey: sessionKey } },
        select: { id: true, trackId: true },
      }),
    ]);
    if (storedSession && storedSession.trackId !== auth.trackId) {
      for (const g of group) fail(g.input.key, 'session_track_mismatch');
      continue;
    }

    // Sequence state, seeded from already-stored events.
    let started = storedEvents.some((e) => e.eventType === 'START');
    let completed = storedEvents.some((e) => e.eventType === 'COMPLETE');
    let lastOccurredMs = storedEvents.length
      ? Math.max(...storedEvents.map((e) => e.occurredAt?.getTime() ?? 0))
      : Number.NEGATIVE_INFINITY;

    // Validate in occurredAt order so a shuffled upload can't smuggle an
    // implausible sequence past the checks. (Wire order is deliberately
    // ignored: idempotent retries and split batches may arrive in any
    // order; occurredAt is the source of truth for sequence.)
    const ordered = [...group].sort((a, b) => a.occurredMs - b.occurredMs);
    const valid: CheckedEvent[] = [];
    for (const g of ordered) {
      const { input, occurredMs } = g;
      if (occurredMs < lastOccurredMs) {
        fail(input.key, 'timestamp_out_of_order');
        continue;
      }
      if (input.type === 'START') {
        if (started) {
          fail(input.key, 'duplicate_start');
          continue;
        }
        started = true;
      } else if (input.type === 'COMPLETE') {
        if (completed) {
          fail(input.key, 'duplicate_complete');
          continue;
        }
        if (!started) {
          fail(input.key, 'complete_without_start');
          continue;
        }
        completed = true;
      } else if (input.type === 'HEARTBEAT') {
        if (!started) {
          fail(input.key, 'heartbeat_without_start');
          continue;
        }
        if (completed) {
          // The engine stops the heartbeat cadence before reporting
          // COMPLETE; a heartbeat after completion cannot be genuine.
          fail(input.key, 'heartbeat_after_complete');
          continue;
        }
      }
      // ERROR is telemetry for failures; allowed at any point in the sequence.
      // Position cadence note: backward jumps (user seeks) are allowed and
      // forward jumps are NOT time-gated — seeks generate no events, so a
      // heartbeat after a forward seek (or a COMPLETE right after seeking
      // near the end) legitimately outruns wall-clock time. Royalty safety
      // does not depend on monotonicity: Phase 15 listening-time math
      // clamps consecutive position deltas to [0, 35s], so neither
      // direction can inflate listening time.
      lastOccurredMs = occurredMs;
      valid.push(g);
    }
    if (valid.length === 0) {
      continue;
    }

    // One synthetic server-side session per offlineSessionKey. It carries
    // no delivery token (tokenHash null) and is never usable for streaming;
    // it exists so offline events join the normal session aggregates that
    // royalty analytics read.
    let session = storedSession;
    if (!session) {
      try {
        session = await db.playbackSession.create({
          data: {
            userId,
            trackId: auth.trackId,
            tokenHash: null,
            offlineSessionKey: sessionKey,
            expiresAt: auth.expiresAt,
          },
          select: { id: true, trackId: true },
        });
      } catch {
        // Concurrent upload created it first: re-read.
        session = await db.playbackSession.findUnique({
          where: { userId_offlineSessionKey: { userId, offlineSessionKey: sessionKey } },
          select: { id: true, trackId: true },
        });
      }
    }
    if (!session) {
      for (const g of valid) fail(g.input.key, 'session_unavailable');
      continue;
    }

    for (const g of valid) {
      const { input, auth: eventAuth } = g;
      const occurredAt = new Date(g.occurredMs);
      try {
        await db.playEvent.create({
          data: {
            sessionId: session.id,
            userId,
            trackId: eventAuth.trackId,
            eventType: input.type,
            positionMs: input.positionMs ?? null,
            // Analytics bucket on actual playback time, not upload time.
            createdAt: occurredAt,
            occurredAt,
            offlineEventKey: input.key,
            offlineAuthorizationId: eventAuth.id,
            offlineSessionKey: sessionKey,
          },
          select: { id: true },
        });
        existingKeys.add(input.key);
        accepted.push(input.key);
      } catch (error) {
        // Only the unique-key race is idempotent (concurrent upload of the
        // same batch won the insert). Any other DB failure is real and
        // must surface, not be silently counted as accepted.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          existingKeys.add(input.key);
          accepted.push(input.key);
        } else {
          throw error;
        }
      }
    }
  }

  return { accepted, rejected };
}
