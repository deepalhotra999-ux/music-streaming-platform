// Phase 29 — artist/fan community. Domain logic for artist posts, flat
// comments, and a single idempotent reaction type.
//
// Boundaries (do not relax without a new ADR):
// - Only ARTIST users can create posts, and only for artists they own.
//   LISTENER/ADMIN cannot create artist posts.
// - Catalog references are IDs only: the referenced track must be READY and
//   belong to the same artist; the referenced album must belong to the same
//   artist. An artist can never attach another artist's content by ID.
// - Only ACTIVE content is served on public/community surfaces. REMOVED
//   (admin moderation) and DELETED (author soft-delete) rows are invisible
//   except to the author and ADMIN.
// - Author identity always comes from the authenticated request; client
//   supplied actor/artist IDs are never trusted.
// - Moderation transitions are admin-only and audited (Phase 16 audit log):
//   ACTIVE -> REMOVED, REMOVED -> ACTIVE, DELETED -> ACTIVE. Ordinary users
//   can never restore content.
// - Community content grants no playback entitlement and mints no playback
//   tokens; playback always goes through the Phase 7 session flow.

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../db.js';
import { badRequest, conflict, forbidden, notFound } from '../../http/errors.js';
import type { AuthUser } from '../../http/auth.js';
import { isAdmin } from '../../http/authorization.js';
import { recordAuditEvent } from '../audit/service.js';
import {
  pageEnvelope,
  parsePagination,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';
import { toTrackSummary } from '../summaries.js';
import type { Config } from '../../config.js';

type Db = PrismaClient | Prisma.TransactionClient;

export type CommunityContentStatus = 'ACTIVE' | 'REMOVED' | 'DELETED';

/** Community-tunable limits. Defaults live in config.ts; tests override. */
export interface CommunityLimits {
  postMaxLength: number;
  commentMaxLength: number;
  duplicateWindowMs: number;
}

export function communityLimits(config: Config): CommunityLimits {
  return {
    postMaxLength: config.community.postMaxLength,
    commentMaxLength: config.community.commentMaxLength,
    duplicateWindowMs: config.community.duplicateWindowMs,
  };
}

// ---------------------------------------------------------------- DTOs ---

export interface CommunityAuthorDto {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface PostArtistRef {
  id: string;
  name: string;
  verified: boolean;
}

export interface PostTrackRef {
  id: string;
  title: string;
  artistName: string;
  durationMs: number;
  albumTitle: string | null;
}

export interface PostAlbumRef {
  id: string;
  title: string;
  artistName: string;
  coverArtUrl: string | null;
}

export interface ArtistPostDto {
  id: string;
  artist: PostArtistRef;
  author: CommunityAuthorDto;
  body: string;
  track: PostTrackRef | null;
  album: PostAlbumRef | null;
  status: CommunityContentStatus;
  reactionCount: number;
  commentCount: number;
  /** Null on public (unauthenticated) views. */
  viewerReacted: boolean | null;
  publishedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PostCommentDto {
  id: string;
  postId: string;
  author: CommunityAuthorDto;
  body: string;
  status: CommunityContentStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePostInput {
  artistId: string;
  body: string;
  trackId?: string;
  albumId?: string;
}

export interface UpdatePostInput {
  body?: string;
  trackId?: string | null;
  albumId?: string | null;
}

// ------------------------------------------------------- internal rows ---

interface PostRow {
  id: string;
  artistId: string;
  authorUserId: string;
  body: string;
  trackId: string | null;
  albumId: string | null;
  status: CommunityContentStatus;
  publishedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  artist: PostArtistRef;
  author: { id: string; displayName: string; avatarUrl: string | null };
  track: {
    id: string;
    title: string;
    durationMs: number;
    status: string;
    artistId: string;
    artist: { name: string };
    albumId: string | null;
    album: { title: string } | null;
  } | null;
  album: {
    id: string;
    title: string;
    artist: { name: string };
    coverArtUrl: string | null;
  } | null;
}

const postInclude = {
  artist: { select: { id: true, name: true, verified: true } },
  author: { select: { id: true, displayName: true, avatarUrl: true } },
  track: {
    select: {
      id: true,
      title: true,
      durationMs: true,
      status: true,
      artistId: true,
      artist: { select: { name: true } },
      albumId: true,
      album: { select: { title: true } },
    },
  },
  album: {
    select: {
      id: true,
      title: true,
      artist: { select: { name: true } },
      coverArtUrl: true,
    },
  },
} as const;

function toPostDto(
  row: PostRow,
  counts: { reactions: number; comments: number },
  viewerReacted: boolean | null,
): ArtistPostDto {
  return {
    id: row.id,
    artist: row.artist,
    author: row.author,
    body: row.body,
    track: row.track
      ? {
          id: row.track.id,
          title: row.track.title,
          artistName: row.track.artist.name,
          durationMs: row.track.durationMs,
          albumTitle: row.track.album?.title ?? null,
        }
      : null,
    album: row.album
      ? {
          id: row.album.id,
          title: row.album.title,
          artistName: row.album.artist.name,
          coverArtUrl: row.album.coverArtUrl,
        }
      : null,
    status: row.status,
    reactionCount: counts.reactions,
    commentCount: counts.comments,
    viewerReacted,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCommentDto(row: {
  id: string;
  postId: string;
  body: string;
  status: CommunityContentStatus;
  createdAt: Date;
  updatedAt: Date;
  author: { id: string; displayName: string; avatarUrl: string | null };
}): PostCommentDto {
  return {
    id: row.id,
    postId: row.postId,
    author: row.author,
    body: row.body,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ------------------------------------------------------------ helpers ---

function cleanBody(body: string | undefined, maxLength: number, label: string): string {
  const cleaned = (body ?? '').trim();
  if (cleaned.length === 0) {
    throw badRequest(`${label} must not be blank.`);
  }
  if (cleaned.length > maxLength) {
    throw badRequest(`${label} must be at most ${maxLength} characters.`);
  }
  return cleaned;
}

async function assertOwnedArtist(db: Db, actor: AuthUser, artistId: string): Promise<void> {
  const artist = await db.artist.findFirst({
    where: { id: artistId, deletedAt: null },
    select: { id: true, ownerUserId: true },
  });
  if (!artist) {
    throw notFound('Artist not found.');
  }
  // ADMIN retains moderation authority only — posting is an artist action.
  if (artist.ownerUserId !== actor.id) {
    throw forbidden('You can only post as an artist you own.');
  }
}

/**
 * Validates an optional catalog attachment. The referenced row must exist,
 * be visible (not soft-deleted), and belong to the posting artist — an
 * artist can never attach another artist's private/internal content by ID.
 * Tracks must additionally be READY (the streaming layer's playability
 * gate); drafts, failed ingests, and takedowns are not referenceable.
 */
async function assertCatalogAttachment(
  db: Db,
  artistId: string,
  trackId: string | undefined | null,
  albumId: string | undefined | null,
): Promise<void> {
  if (trackId !== undefined && trackId !== null) {
    const track = await db.track.findFirst({
      where: { id: trackId, deletedAt: null },
      select: { id: true, artistId: true, status: true },
    });
    if (!track || track.artistId !== artistId) {
      throw notFound('Track not found.');
    }
    if (track.status !== 'READY') {
      throw badRequest('Only published (READY) tracks can be attached to a post.');
    }
  }
  if (albumId !== undefined && albumId !== null) {
    const album = await db.album.findFirst({
      where: { id: albumId, deletedAt: null },
      select: { id: true, artistId: true },
    });
    if (!album || album.artistId !== artistId) {
      throw notFound('Album not found.');
    }
  }
}

async function getPostRow(db: Db, postId: string): Promise<PostRow> {
  const row = await db.artistPost.findUnique({
    where: { id: postId },
    include: postInclude,
  });
  if (!row) {
    throw notFound('Post not found.');
  }
  return row as PostRow;
}

/** ACTIVE posts are public; anything else is visible to the author and ADMIN only. */
function assertCanViewPost(actor: AuthUser | null, row: PostRow): void {
  if (row.status === 'ACTIVE') return;
  if (actor && (row.authorUserId === actor.id || isAdmin(actor))) return;
  // Existence-hiding 404: non-ACTIVE content is invisible to outsiders.
  throw notFound('Post not found.');
}

async function postCounts(
  db: Db,
  postIds: string[],
): Promise<Map<string, { reactions: number; comments: number }>> {
  if (postIds.length === 0) return new Map();
  const [reactions, comments] = await Promise.all([
    db.postReaction.groupBy({ by: ['postId'], where: { postId: { in: postIds } }, _count: true }),
    db.postComment.groupBy({
      by: ['postId'],
      where: { postId: { in: postIds }, status: 'ACTIVE' },
      _count: true,
    }),
  ]);
  const map = new Map<string, { reactions: number; comments: number }>();
  for (const id of postIds) map.set(id, { reactions: 0, comments: 0 });
  for (const r of reactions) map.get(r.postId)!.reactions = r._count;
  for (const c of comments) map.get(c.postId)!.comments = c._count;
  return map;
}

async function viewerReactions(
  db: Db,
  viewerId: string | null,
  postIds: string[],
): Promise<Set<string>> {
  if (!viewerId || postIds.length === 0) return new Set();
  const rows = await db.postReaction.findMany({
    where: { userId: viewerId, postId: { in: postIds } },
    select: { postId: true },
  });
  return new Set(rows.map((r) => r.postId));
}

async function hydratePosts(
  db: Db,
  rows: PostRow[],
  viewerId: string | null,
): Promise<ArtistPostDto[]> {
  const ids = rows.map((r) => r.id);
  const [counts, reacted] = await Promise.all([
    postCounts(db, ids),
    viewerReactions(db, viewerId, ids),
  ]);
  return rows.map((row) =>
    toPostDto(
      row,
      counts.get(row.id) ?? { reactions: 0, comments: 0 },
      viewerId ? reacted.has(row.id) : null,
    ),
  );
}

// ---------------------------------------------------------------- posts ---

export async function createPost(
  actor: AuthUser,
  input: CreatePostInput,
  limits: CommunityLimits,
  db: Db = prisma,
): Promise<ArtistPostDto> {
  if (actor.role !== 'ARTIST') {
    // Deliberately 403 (not 404): the caller is authenticated but the
    // ARTIST role is required to publish artist posts.
    throw forbidden('Only artist accounts can create artist posts.');
  }
  await assertOwnedArtist(db, actor, input.artistId);
  const body = cleanBody(input.body, limits.postMaxLength, 'Post body');
  await assertCatalogAttachment(db, input.artistId, input.trackId, input.albumId);

  // Duplicate protection: an identical post by the same author for the same
  // artist inside the window is rejected — cheap local anti-spam.
  const recentDuplicate = await db.artistPost.findFirst({
    where: {
      artistId: input.artistId,
      authorUserId: actor.id,
      body,
      createdAt: { gte: new Date(Date.now() - limits.duplicateWindowMs) },
    },
    select: { id: true },
  });
  if (recentDuplicate) {
    throw conflict('An identical post was published very recently.');
  }

  const row = (await db.artistPost.create({
    data: {
      artistId: input.artistId,
      authorUserId: actor.id,
      body,
      trackId: input.trackId ?? null,
      albumId: input.albumId ?? null,
    },
    include: postInclude,
  })) as unknown as PostRow;
  return (await hydratePosts(db, [row], actor.id))[0]!;
}

export async function updatePost(
  actor: AuthUser,
  postId: string,
  input: UpdatePostInput,
  limits: CommunityLimits,
  db: Db = prisma,
): Promise<ArtistPostDto> {
  const existing = await getPostRow(db, postId);
  const canEdit = existing.authorUserId === actor.id || isAdmin(actor);
  if (!canEdit) {
    throw forbidden('You can only edit your own posts.');
  }
  if (!isAdmin(actor) && existing.status !== 'ACTIVE') {
    throw badRequest('Only active posts can be edited. Ask an admin to restore it first.');
  }
  if (isAdmin(actor) && existing.status === 'DELETED') {
    throw badRequest('Deleted posts cannot be edited; restore them first.');
  }

  const data: Prisma.ArtistPostUpdateInput = {};
  if (input.body !== undefined) {
    data.body = cleanBody(input.body, limits.postMaxLength, 'Post body');
  }
  if (input.trackId !== undefined || input.albumId !== undefined) {
    const trackId = input.trackId !== undefined ? input.trackId : existing.trackId;
    const albumId = input.albumId !== undefined ? input.albumId : existing.albumId;
    await assertCatalogAttachment(db, existing.artistId, trackId, albumId);
    // Optional FKs are set through the nested relation API (the checked
    // update input exposes the relation, not the scalar FK).
    if (input.trackId !== undefined) {
      data.track =
        input.trackId === null ? { disconnect: true } : { connect: { id: input.trackId } };
    }
    if (input.albumId !== undefined) {
      data.album =
        input.albumId === null ? { disconnect: true } : { connect: { id: input.albumId } };
    }
  }

  const row = (await db.artistPost.update({
    where: { id: postId },
    data,
    include: postInclude,
  })) as unknown as PostRow;
  return (await hydratePosts(db, [row], actor.id))[0]!;
}

/** Author soft-delete. Admin moderation uses moderatePost instead. */
export async function deletePost(actor: AuthUser, postId: string, db: Db = prisma): Promise<void> {
  const existing = await getPostRow(db, postId);
  if (existing.authorUserId !== actor.id) {
    throw forbidden('You can only delete your own posts.');
  }
  if (existing.status === 'DELETED') return; // idempotent
  if (existing.status !== 'ACTIVE') {
    throw badRequest('Only active posts can be deleted.');
  }
  await db.artistPost.update({ where: { id: postId }, data: { status: 'DELETED' } });
}

export async function getPost(
  actor: AuthUser | null,
  postId: string,
  db: Db = prisma,
): Promise<ArtistPostDto> {
  const row = await getPostRow(db, postId);
  assertCanViewPost(actor, row);
  return (await hydratePosts(db, [row], actor?.id ?? null))[0]!;
}

/** Public artist-profile posts: ACTIVE only, newest first. */
export async function listArtistPosts(
  artistId: string,
  query: PaginationQuery,
  db: Db = prisma,
): Promise<PageEnvelope<ArtistPostDto>> {
  const artist = await db.artist.findFirst({
    where: { id: artistId, deletedAt: null },
    select: { id: true },
  });
  if (!artist) {
    throw notFound('Artist not found.');
  }
  const p = parsePagination(query);
  const where = { artistId, status: 'ACTIVE' as CommunityContentStatus };
  const [rows, total] = await Promise.all([
    db.artistPost.findMany({
      where,
      include: postInclude,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      skip: p.skip,
      take: p.limit,
    }),
    db.artistPost.count({ where }),
  ]);
  const dtos = await hydratePosts(db, rows as unknown as PostRow[], null);
  return pageEnvelope(dtos, total, p);
}

/**
 * Followed-artist feed: ACTIVE posts from artists the caller follows,
 * newest first with the post id as a deterministic tie-break so pages are
 * stable and duplicates across pages are avoided.
 */
export async function getCommunityFeed(
  userId: string,
  query: PaginationQuery,
  db: Db = prisma,
): Promise<PageEnvelope<ArtistPostDto>> {
  const p = parsePagination(query);
  const follows = await db.follow.findMany({
    where: { userId, artist: { deletedAt: null } },
    select: { artistId: true },
  });
  if (follows.length === 0) {
    return pageEnvelope([], 0, p);
  }
  const artistIds = follows.map((f) => f.artistId);
  const where = {
    artistId: { in: artistIds },
    status: 'ACTIVE' as CommunityContentStatus,
  };
  const [rows, total] = await Promise.all([
    db.artistPost.findMany({
      where,
      include: postInclude,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      skip: p.skip,
      take: p.limit,
    }),
    db.artistPost.count({ where }),
  ]);
  const dtos = await hydratePosts(db, rows as unknown as PostRow[], userId);
  return pageEnvelope(dtos, total, p);
}

// -------------------------------------------------------------- comments ---

export async function createComment(
  actor: AuthUser,
  postId: string,
  body: string,
  limits: CommunityLimits,
  db: Db = prisma,
): Promise<PostCommentDto> {
  const post = await getPostRow(db, postId);
  if (post.status !== 'ACTIVE') {
    // 404, not 403: non-active posts do not accept comments and their
    // existence is not advertised to non-privileged callers.
    assertCanViewPost(actor, post);
    throw badRequest('Comments are closed on this post.');
  }
  const cleaned = cleanBody(body, limits.commentMaxLength, 'Comment');
  const row = await db.postComment.create({
    data: { postId, authorUserId: actor.id, body: cleaned },
    include: { author: { select: { id: true, displayName: true, avatarUrl: true } } },
  });
  return toCommentDto(row);
}

/** Author-only soft delete. Admin removal goes through moderateComment. */
export async function deleteComment(
  actor: AuthUser,
  commentId: string,
  db: Db = prisma,
): Promise<void> {
  const existing = await db.postComment.findUnique({ where: { id: commentId } });
  if (!existing) {
    throw notFound('Comment not found.');
  }
  if (existing.authorUserId !== actor.id) {
    throw forbidden('You can only delete your own comments.');
  }
  if (existing.status === 'DELETED') return; // idempotent
  await db.postComment.update({ where: { id: commentId }, data: { status: 'DELETED' } });
}

/** Flat comment list: ACTIVE only, oldest first. */
export async function listComments(
  actor: AuthUser,
  postId: string,
  query: PaginationQuery,
  db: Db = prisma,
): Promise<PageEnvelope<PostCommentDto>> {
  const post = await getPostRow(db, postId);
  assertCanViewPost(actor, post);
  const p = parsePagination(query);
  const where = { postId, status: 'ACTIVE' as CommunityContentStatus };
  const [rows, total] = await Promise.all([
    db.postComment.findMany({
      where,
      include: { author: { select: { id: true, displayName: true, avatarUrl: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: p.skip,
      take: p.limit,
    }),
    db.postComment.count({ where }),
  ]);
  return pageEnvelope(rows.map(toCommentDto), total, p);
}

// ------------------------------------------------------------- reactions ---

export async function addReaction(
  actor: AuthUser,
  postId: string,
  db: Db = prisma,
): Promise<{ reacted: boolean; reactionCount: number }> {
  const post = await getPostRow(db, postId);
  assertCanViewPost(actor, post);
  if (post.status !== 'ACTIVE') {
    throw badRequest('Reactions are closed on this post.');
  }
  // Composite PK makes this idempotent at the database level.
  await db.postReaction.upsert({
    where: { postId_userId: { postId, userId: actor.id } },
    create: { postId, userId: actor.id },
    update: {},
  });
  const reactionCount = await db.postReaction.count({ where: { postId } });
  return { reacted: true, reactionCount };
}

export async function removeReaction(
  actor: AuthUser,
  postId: string,
  db: Db = prisma,
): Promise<{ reacted: boolean; reactionCount: number }> {
  const post = await getPostRow(db, postId);
  assertCanViewPost(actor, post);
  // Idempotent: deleting zero rows is fine.
  await db.postReaction.deleteMany({ where: { postId, userId: actor.id } });
  const reactionCount = await db.postReaction.count({ where: { postId } });
  return { reacted: false, reactionCount };
}

// ------------------------------------------------------------ moderation ---

async function setPostStatus(
  admin: AuthUser,
  postId: string,
  to: CommunityContentStatus,
  from: readonly CommunityContentStatus[],
  action: 'community.post.removed' | 'community.post.restored',
  db: PrismaClient = prisma,
): Promise<ArtistPostDto> {
  const existing = await getPostRow(db, postId);
  if (!from.includes(existing.status)) {
    throw badRequest(`Cannot move a post from ${existing.status} to ${to}.`);
  }
  const row = await db.$transaction(async (tx) => {
    const updated = (await tx.artistPost.update({
      where: { id: postId },
      data: { status: to },
      include: postInclude,
    })) as unknown as PostRow;
    await recordAuditEvent(
      {
        actorId: admin.id,
        action,
        targetType: 'artist_post',
        targetId: postId,
        metadata: {
          oldStatus: existing.status,
          newStatus: to,
          artistId: existing.artistId,
        },
      },
      tx,
    );
    return updated;
  });
  return (await hydratePosts(db, [row], admin.id))[0]!;
}

/** ADMIN-only: ACTIVE|DELETED -> REMOVED. Ordinary users can never do this. */
export function moderatePost(
  admin: AuthUser,
  postId: string,
  db: PrismaClient = prisma,
): Promise<ArtistPostDto> {
  return setPostStatus(
    admin,
    postId,
    'REMOVED',
    ['ACTIVE', 'DELETED'],
    'community.post.removed',
    db,
  );
}

/** ADMIN-only: REMOVED|DELETED -> ACTIVE. Ordinary users can never restore. */
export function restorePost(
  admin: AuthUser,
  postId: string,
  db: PrismaClient = prisma,
): Promise<ArtistPostDto> {
  return setPostStatus(
    admin,
    postId,
    'ACTIVE',
    ['REMOVED', 'DELETED'],
    'community.post.restored',
    db,
  );
}

async function setCommentStatus(
  admin: AuthUser,
  commentId: string,
  to: CommunityContentStatus,
  from: readonly CommunityContentStatus[],
  action: 'community.comment.removed' | 'community.comment.restored',
  db: PrismaClient = prisma,
): Promise<PostCommentDto> {
  const existing = await db.postComment.findUnique({ where: { id: commentId } });
  if (!existing) {
    throw notFound('Comment not found.');
  }
  if (!from.includes(existing.status as CommunityContentStatus)) {
    throw badRequest(`Cannot move a comment from ${existing.status} to ${to}.`);
  }
  const row = await db.$transaction(async (tx) => {
    const updated = await tx.postComment.update({
      where: { id: commentId },
      data: { status: to },
      include: { author: { select: { id: true, displayName: true, avatarUrl: true } } },
    });
    await recordAuditEvent(
      {
        actorId: admin.id,
        action,
        targetType: 'post_comment',
        targetId: commentId,
        metadata: {
          oldStatus: existing.status,
          newStatus: to,
          postId: existing.postId,
        },
      },
      tx,
    );
    return updated;
  });
  return toCommentDto(row);
}

/** ADMIN-only: ACTIVE|DELETED -> REMOVED. */
export function moderateComment(
  admin: AuthUser,
  commentId: string,
  db: PrismaClient = prisma,
): Promise<PostCommentDto> {
  return setCommentStatus(
    admin,
    commentId,
    'REMOVED',
    ['ACTIVE', 'DELETED'],
    'community.comment.removed',
    db,
  );
}

/** ADMIN-only: REMOVED|DELETED -> ACTIVE. */
export function restoreComment(
  admin: AuthUser,
  commentId: string,
  db: PrismaClient = prisma,
): Promise<PostCommentDto> {
  return setCommentStatus(
    admin,
    commentId,
    'ACTIVE',
    ['REMOVED', 'DELETED'],
    'community.comment.restored',
    db,
  );
}

/** ADMIN-only content review: any status, for the moderation UI. */
export async function getPostForAdmin(postId: string, db: Db = prisma): Promise<ArtistPostDto> {
  const row = await getPostRow(db, postId);
  return (await hydratePosts(db, [row], null))[0]!;
}

/** ADMIN-only content review: any status, for the moderation UI. */
export async function getCommentForAdmin(
  commentId: string,
  db: Db = prisma,
): Promise<PostCommentDto> {
  const row = await db.postComment.findUnique({
    where: { id: commentId },
    include: { author: { select: { id: true, displayName: true, avatarUrl: true } } },
  });
  if (!row) {
    throw notFound('Comment not found.');
  }
  return toCommentDto(row);
}

// Re-exported for the mobile contract tests: track reference shape uses the
// shared catalog summary so post attachments always match catalog data.
export { toTrackSummary };
