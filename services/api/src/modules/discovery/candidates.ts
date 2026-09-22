// Phase 26 — candidate generation.
//
// Each generator produces track IDs from real catalog data, tagged with a
// source for reason derivation and telemetry. Generators never invent
// entities: every candidate is a track row that exists at generation time.
// Final availability filtering happens later in authz.ts (the authoritative
// gate), so generators only apply cheap pre-filters.
//
// Performance: every generator is capped (policy.maxCandidatesPerGenerator)
// and uses indexed queries. No full-catalog scans.

import type { PrismaClient } from '@prisma/client';
import type { Candidate, DiscoveryConstraints, SignalProfile } from './types.js';
import type { RecommendationPolicy } from './policies.js';

type Db = PrismaClient;

export interface CandidateSet {
  candidates: Candidate[];
  /** Per-generator counts, for telemetry (no private data). */
  bySource: Record<string, number>;
}

const READY = 'READY' as const;

function pushUnique(out: Candidate[], seen: Set<string>, c: Candidate): void {
  if (seen.has(c.trackId)) return;
  seen.add(c.trackId);
  out.push(c);
}

/**
 * Tracks related to recently played ones: same artist or shared genre.
 * Excludes tracks the user already heard recently.
 */
async function recentlyPlayedRelated(
  db: Db,
  profile: SignalProfile,
  cap: number,
  out: Candidate[],
  seen: Set<string>,
): Promise<void> {
  if (profile.recentTrackIds.length === 0) return;
  const recent = await db.track.findMany({
    where: { id: { in: profile.recentTrackIds.slice(0, 10) } },
    select: {
      id: true,
      artistId: true,
      genres: { select: { genreId: true } },
    },
  });
  const artistIds = [...new Set(recent.map((t) => t.artistId))];
  const genreIds = [...new Set(recent.flatMap((t) => t.genres.map((g) => g.genreId)))].slice(0, 8);
  const related = await db.track.findMany({
    where: {
      status: READY,
      deletedAt: null,
      id: { notIn: profile.recentTrackIds },
      OR: [{ artistId: { in: artistIds } }, { genres: { some: { genreId: { in: genreIds } } } }],
    },
    orderBy: { playCount: 'desc' },
    take: cap,
    select: { id: true, artistId: true },
  });
  for (const t of related) {
    pushUnique(out, seen, {
      trackId: t.id,
      source: 'recently_played_related',
      anchorId: t.artistId,
      anchorKind: 'artist',
    });
  }
}

/** Tracks from artists the user liked tracks by or follows. */
async function affinityArtists(
  db: Db,
  artistIds: string[],
  source: 'liked_artist' | 'followed_artist',
  cap: number,
  out: Candidate[],
  seen: Set<string>,
): Promise<void> {
  if (artistIds.length === 0) return;
  const tracks = await db.track.findMany({
    where: { status: READY, deletedAt: null, artistId: { in: artistIds } },
    orderBy: { playCount: 'desc' },
    take: cap,
    select: { id: true, artistId: true },
  });
  for (const t of tracks) {
    pushUnique(out, seen, {
      trackId: t.id,
      source,
      anchorId: t.artistId,
      anchorKind: 'artist',
    });
  }
}

/** Tracks in the user's top genres. */
async function genreAffinity(
  db: Db,
  profile: SignalProfile,
  cap: number,
  out: Candidate[],
  seen: Set<string>,
): Promise<void> {
  if (profile.topGenreIds.length === 0) return;
  const tracks = await db.track.findMany({
    where: {
      status: READY,
      deletedAt: null,
      genres: { some: { genreId: { in: profile.topGenreIds } } },
    },
    orderBy: { playCount: 'desc' },
    take: cap,
    select: { id: true },
  });
  for (const t of tracks) {
    pushUnique(out, seen, {
      trackId: t.id,
      source: 'genre_affinity',
      anchorId: null,
      anchorKind: null,
    });
  }
}

/** Globally popular READY tracks (cold-start and exploration fuel). */
export async function popularTracks(
  db: Db,
  cap: number,
  out: Candidate[],
  seen: Set<string>,
): Promise<void> {
  const tracks = await db.track.findMany({
    where: { status: READY, deletedAt: null },
    orderBy: { playCount: 'desc' },
    take: cap,
    select: { id: true },
  });
  for (const t of tracks) {
    pushUnique(out, seen, {
      trackId: t.id,
      source: 'popular',
      anchorId: null,
      anchorKind: null,
    });
  }
}

/** Recently added READY tracks (freshness). */
async function newReleases(
  db: Db,
  cap: number,
  out: Candidate[],
  seen: Set<string>,
): Promise<void> {
  const tracks = await db.track.findMany({
    where: { status: READY, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: cap,
    select: { id: true },
  });
  for (const t of tracks) {
    pushUnique(out, seen, {
      trackId: t.id,
      source: 'new_release',
      anchorId: null,
      anchorKind: null,
    });
  }
}

/**
 * Assemble the candidate pool for a recommendation request.
 *
 * Cold-start users get popular + new-release + emerging candidates only;
 * personalized generators are skipped so we never fabricate personalization.
 */
export async function generateCandidates(
  db: Db,
  profile: SignalProfile,
  constraints: DiscoveryConstraints,
  policy: RecommendationPolicy,
  emergingTrackIds: string[],
): Promise<CandidateSet> {
  const cap = policy.maxCandidatesPerGenerator;
  const out: Candidate[] = [];
  const seen = new Set<string>();

  if (!profile.isColdStart) {
    await recentlyPlayedRelated(db, profile, cap, out, seen);
    await affinityArtists(
      db,
      [...profile.likedArtistIds, ...profile.followedArtistIds].slice(0, 10),
      'liked_artist',
      cap,
      out,
      seen,
    );
    await affinityArtists(
      db,
      profile.followedArtistIds.slice(0, 10),
      'followed_artist',
      cap,
      out,
      seen,
    );
    await genreAffinity(db, profile, cap, out, seen);
  }

  // Constraint-driven candidates: explicit genre/artist filters from the
  // structured discovery constraints (AI or deterministic).
  if (constraints.genreIds.length > 0) {
    const tracks = await db.track.findMany({
      where: {
        status: READY,
        deletedAt: null,
        genres: { some: { genreId: { in: constraints.genreIds } } },
      },
      orderBy: { playCount: 'desc' },
      take: cap,
      select: { id: true },
    });
    for (const t of tracks) {
      pushUnique(out, seen, {
        trackId: t.id,
        source: 'genre_affinity',
        anchorId: null,
        anchorKind: 'genre',
      });
    }
  }
  if (constraints.artistIds.length > 0) {
    const tracks = await db.track.findMany({
      where: {
        status: READY,
        deletedAt: null,
        artistId: { in: constraints.artistIds },
      },
      orderBy: { playCount: 'desc' },
      take: cap,
      select: { id: true, artistId: true },
    });
    for (const t of tracks) {
      pushUnique(out, seen, {
        trackId: t.id,
        source: 'similar_artist',
        anchorId: t.artistId,
        anchorKind: 'artist',
      });
    }
  }

  // Emerging-artist candidates (bounded by the emerging policy).
  for (const trackId of emergingTrackIds.slice(0, cap)) {
    pushUnique(out, seen, {
      trackId,
      source: 'emerging',
      anchorId: null,
      anchorKind: 'artist',
    });
  }

  await newReleases(db, Math.floor(cap / 2), out, seen);
  // Popular tracks always run: they backfill thin personalized pools and
  // form the entire cold-start pool.
  await popularTracks(
    db,
    profile.isColdStart ? policy.coldStartPopularCount : Math.floor(cap / 2),
    out,
    seen,
  );

  const trimmed = out.slice(0, policy.maxCandidatePool);
  const bySource: Record<string, number> = {};
  for (const c of trimmed) {
    bySource[c.source] = (bySource[c.source] ?? 0) + 1;
  }
  return { candidates: trimmed, bySource };
}
