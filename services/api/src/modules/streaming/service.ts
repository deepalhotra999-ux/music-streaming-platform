// Phase 7 — streaming. Playback sessions and play events.
//
// A playback session is the single gate for audio delivery: the client
// exchanges one authenticated `POST /v1/playback/sessions` call for an opaque,
// short-lived token, and every manifest/segment fetch re-validates that token.
// No permanent public audio URL ever exists — when the session expires, every
// derived URL dies with it.
//
// Play events (START / HEARTBEAT / COMPLETE / ERROR) are append-only stream
// telemetry. They are the raw material for royalty reporting and fraud
// detection in later phases, kept separate from user-facing listening_history.

import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient, PlayEventType } from '@prisma/client';
import { prisma } from '../../db.js';
import type { Config } from '../../config.js';
import { conflict, notFound, subscriptionRequired, unauthorized } from '../../http/errors.js';
import { checkPlaybackEntitlement } from './entitlements.js';
import { masterKey, type AudioStorage } from './storage.js';

export interface StreamingDeps {
  db: PrismaClient;
  config: Config;
  storage: AudioStorage;
}

export interface PlaybackSessionResult {
  id: string;
  /** Opaque token. Shown to the client exactly once, at creation. */
  token: string;
  expiresAt: Date;
  /** Session-scoped master playlist URL (token embedded). */
  hlsUrl: string;
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  trackId: string;
  expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sessionBasePath(): string {
  return '/v1/playback';
}

interface AvailableTrack {
  id: string;
}

/**
 * Track availability for streaming: the track must exist, not be
 * soft-deleted, and be in READY status. Anything else is a client-visible
 * error, never silent.
 */
async function requireStreamableTrack(trackId: string, db: PrismaClient): Promise<AvailableTrack> {
  const track = await db.track.findFirst({
    where: { id: trackId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!track) {
    throw notFound('Track not found.');
  }
  if (track.status !== 'READY') {
    throw conflict(`Track is not available for streaming (status: ${track.status}).`);
  }
  return track;
}

/**
 * Create a playback session: availability → entitlement → token issuance.
 * Throws HttpProblem errors the central handler renders as RFC 7807.
 */
export async function createPlaybackSession(
  userId: string,
  trackId: string,
  deps: StreamingDeps,
): Promise<PlaybackSessionResult> {
  const { db, config, storage } = deps;

  const track = await requireStreamableTrack(trackId, db);

  const entitlement = await checkPlaybackEntitlement({ userId, trackId: track.id, db });
  if (!entitlement.allowed) {
    // Dedicated problem type (not generic 403) so clients can render
    // locked UI. The reason carries only the denial category, never
    // provider internals.
    throw subscriptionRequired(`Playback not allowed: ${entitlement.reason}`);
  }

  // The catalog says READY but the audio package must actually be on disk
  // (or in the bucket) — otherwise the player would get a broken session.
  if (!(await storage.exists(masterKey(track.id)))) {
    throw conflict('Audio is not available for this track yet.');
  }

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.streaming.playbackSessionTtlSeconds * 1000);

  const session = await db.playbackSession.create({
    data: {
      userId,
      trackId: track.id,
      tokenHash: hashToken(token),
      expiresAt,
    },
    select: { id: true, expiresAt: true },
  });

  return {
    id: session.id,
    token,
    expiresAt: session.expiresAt,
    hlsUrl: `${sessionBasePath()}/hls/master.m3u8?token=${token}`,
  };
}

/**
 * Validate a session token for manifest/segment delivery. Invalid and
 * expired tokens are indistinguishable to the caller (both 401) so tokens
 * cannot be probed.
 */
export async function resolvePlaybackSession(
  token: string,
  deps: Pick<StreamingDeps, 'db'>,
): Promise<ResolvedSession> {
  const session = await deps.db.playbackSession.findFirst({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      userId: true,
      trackId: true,
      expiresAt: true,
      track: { select: { status: true, deletedAt: true } },
    },
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    throw unauthorized('Playback session is invalid or has expired.');
  }
  if (!session.track || session.track.deletedAt !== null || session.track.status !== 'READY') {
    throw conflict('Track is no longer available for streaming.');
  }
  return {
    sessionId: session.id,
    userId: session.userId,
    trackId: session.trackId,
    expiresAt: session.expiresAt,
  };
}

/**
 * Load a session for the events endpoint: must belong to the caller.
 * Other users' sessions read as 404 (no existence leak); expired sessions
 * read as 401.
 */
export async function getSessionForEvents(
  sessionId: string,
  userId: string,
  db: PrismaClient = prisma,
): Promise<ResolvedSession> {
  const session = await db.playbackSession.findFirst({
    where: { id: sessionId, userId },
    select: { id: true, userId: true, trackId: true, expiresAt: true },
  });
  if (!session) {
    throw notFound('Playback session not found.');
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw unauthorized('Playback session has expired.');
  }
  return {
    sessionId: session.id,
    userId: session.userId,
    trackId: session.trackId,
    expiresAt: session.expiresAt,
  };
}

export interface RecordPlayEventInput {
  sessionId: string;
  userId: string;
  trackId: string;
  eventType: PlayEventType;
  positionMs?: number;
}

/** Append one play event. Append-only: events are never updated or deleted. */
export async function recordPlayEvent(
  input: RecordPlayEventInput,
  db: PrismaClient = prisma,
): Promise<{ id: string }> {
  if (
    input.positionMs !== undefined &&
    (!Number.isInteger(input.positionMs) || input.positionMs < 0)
  ) {
    throw new Error('positionMs must be a non-negative integer.');
  }
  const event = await db.playEvent.create({
    data: {
      sessionId: input.sessionId,
      userId: input.userId,
      trackId: input.trackId,
      eventType: input.eventType,
      positionMs: input.positionMs ?? null,
    },
    select: { id: true },
  });
  return { id: event.id };
}
