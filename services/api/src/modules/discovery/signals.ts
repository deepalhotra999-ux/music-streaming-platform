// Phase 26 — user signal extraction.
//
// Reads first-party behavioral data server-side and distills it into a
// SignalProfile. Privacy rules:
// - Everything stays in the backend; nothing leaves the process except the
//   aggregated profile used by candidate generation.
// - Search history is deliberately NOT consumed here: search queries can
//   contain sensitive free text, so the brief restricts their use to
//   privacy-safe cases only. We do not ingest them.
// - Signal strengths are explicit: a completed play is positive, a short
//   incomplete play is NOT a strong negative, and we do not invent skips
//   (the event model has no skip event).
//
// Query discipline: capped, indexed reads only. We never load an entire
// listening history into memory.

import type { PrismaClient } from '@prisma/client';
import type { SignalProfile, UserSignal } from './types.js';

type Db = PrismaClient;

/** How far back we look for taste signals. */
const SIGNAL_WINDOW_DAYS = 90;
/** Cap on history rows scanned per user. */
const MAX_HISTORY_ROWS = 500;
/** A "completed" play counts as a strong positive signal. */
const COMPLETED_PLAY = 'completed_play';

export interface SignalExtraction {
  profile: SignalProfile;
  /** Raw signals, kept for reason derivation and tests. */
  signals: UserSignal[];
}

function recencyWeight(observedAt: Date, now: Date): number {
  const days = Math.max(0, (now.getTime() - observedAt.getTime()) / (24 * 60 * 60 * 1000));
  // Linear decay to 0.2 at the edge of the window.
  return Math.max(0.2, 1 - (days / SIGNAL_WINDOW_DAYS) * 0.8);
}

export async function extractSignals(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<SignalExtraction> {
  const windowStart = new Date(now.getTime() - SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Listening history: completed plays are strong positives; partial plays
  // are weak (we must not treat every playback event as an explicit
  // preference, and a short/incomplete play is not a strong negative).
  const history = await db.listeningHistory.findMany({
    where: { userId, playedAt: { gte: windowStart } },
    orderBy: { playedAt: 'desc' },
    take: MAX_HISTORY_ROWS,
    select: {
      trackId: true,
      playedAt: true,
      completed: true,
      track: { select: { artistId: true } },
    },
  });

  const signals: UserSignal[] = [];
  const artistPlays = new Map<string, number>();
  const trackPlays = new Map<string, number>();
  const recentTrackIds: string[] = [];

  for (const row of history) {
    const completed = row.completed;
    signals.push({
      kind: completed ? 'completed_play' : 'partial_play',
      strength: completed ? 'strong' : 'weak',
      trackId: row.trackId,
      artistId: row.track.artistId,
      recency: recencyWeight(row.playedAt, now),
      observedAt: row.playedAt,
    });
    artistPlays.set(
      row.track.artistId,
      (artistPlays.get(row.track.artistId) ?? 0) + (completed ? 2 : 1),
    );
    trackPlays.set(row.trackId, (trackPlays.get(row.trackId) ?? 0) + 1);
    if (recentTrackIds.length < 20 && !recentTrackIds.includes(row.trackId)) {
      recentTrackIds.push(row.trackId);
    }
  }

  // Likes: explicit, strong.
  const likes = await db.like.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      trackId: true,
      createdAt: true,
      track: { select: { artistId: true, genres: { select: { genreId: true } } } },
    },
  });
  const likedTrackIds: string[] = [];
  const likedArtistIds: string[] = [];
  const genreAffinity = new Map<string, number>();
  for (const like of likes) {
    likedTrackIds.push(like.trackId);
    if (!likedArtistIds.includes(like.track.artistId)) {
      likedArtistIds.push(like.track.artistId);
    }
    signals.push({
      kind: 'like',
      strength: 'strong',
      trackId: like.trackId,
      artistId: like.track.artistId,
      recency: recencyWeight(like.createdAt, now),
      observedAt: like.createdAt,
    });
    for (const g of like.track.genres) {
      genreAffinity.set(g.genreId, (genreAffinity.get(g.genreId) ?? 0) + 2);
    }
  }

  // Follows: explicit, strong artist affinity.
  const follows = await db.follow.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { artistId: true, createdAt: true },
  });
  const followedArtistIds = follows.map((f) => f.artistId);
  for (const f of follows) {
    signals.push({
      kind: 'follow',
      strength: 'strong',
      artistId: f.artistId,
      recency: recencyWeight(f.createdAt, now),
      observedAt: f.createdAt,
    });
  }

  // Genre affinity from completed plays (weak per-play, summed).
  const genreRows = await db.listeningHistory.findMany({
    where: { userId, playedAt: { gte: windowStart }, completed: true },
    take: MAX_HISTORY_ROWS,
    select: { track: { select: { genres: { select: { genreId: true } } } } },
  });
  for (const row of genreRows) {
    for (const g of row.track.genres) {
      genreAffinity.set(g.genreId, (genreAffinity.get(g.genreId) ?? 0) + 1);
    }
  }

  const topArtistIds = [...artistPlays.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id]) => id);
  const topGenreIds = [...genreAffinity.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id]) => id);

  // Overexposed: tracks played >= 5 times in the window get deprioritized
  // so we avoid recommending the exact same track repeatedly.
  const overexposedTrackIds = [...trackPlays.entries()]
    .filter(([, count]) => count >= 5)
    .map(([id]) => id);

  const isColdStart = history.length === 0 && likes.length === 0 && follows.length === 0;

  return {
    profile: {
      userId,
      isColdStart,
      topArtistIds,
      topGenreIds,
      likedTrackIds,
      likedArtistIds,
      followedArtistIds,
      recentTrackIds,
      overexposedTrackIds,
    },
    signals,
  };
}

/** Exported for tests: the completion signal constant. */
export { COMPLETED_PLAY };
