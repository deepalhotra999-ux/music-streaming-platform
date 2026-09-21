// Phase 4 — artists. Domain logic: public catalog reads, artist creation
// (ARTIST/ADMIN only), owner-or-admin management, and artist profiles.
// Throws HttpProblem errors (see http/errors.ts) which the central handler
// renders as RFC 7807.

import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../../db.js';
import { recordAuditEvent } from '../audit/service.js';
import { conflict, forbidden, notFound } from '../../http/errors.js';
import type { AuthUser } from '../../http/auth.js';
import { canManageArtist, isAdmin } from '../../http/authorization.js';
import {
  pageEnvelope,
  parsePagination,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';

type Db = PrismaClient;

interface ArtistListRow {
  id: string;
  name: string;
  verified: boolean;
  createdAt: Date;
  _count: { followers: number };
}

export interface ArtistListItemDto {
  id: string;
  name: string;
  verified: boolean;
  followerCount: number;
  createdAt: Date;
}

function toListItem(row: ArtistListRow): ArtistListItemDto {
  return {
    id: row.id,
    name: row.name,
    verified: row.verified,
    followerCount: row._count.followers,
    createdAt: row.createdAt,
  };
}

export interface ArtistProfileDto {
  bio: string | null;
  imageUrl: string | null;
  bannerUrl: string | null;
  website: string | null;
  socialLinks: Prisma.JsonValue;
}

function toProfile(row: {
  bio: string | null;
  imageUrl: string | null;
  bannerUrl: string | null;
  website: string | null;
  socialLinks: Prisma.JsonValue;
}): ArtistProfileDto {
  return {
    bio: row.bio,
    imageUrl: row.imageUrl,
    bannerUrl: row.bannerUrl,
    website: row.website,
    socialLinks: row.socialLinks ?? null,
  };
}

export interface ArtistDetailDto {
  id: string;
  name: string;
  verified: boolean;
  createdAt: Date;
  updatedAt: Date;
  profile: ArtistProfileDto | null;
  counts: { albums: number; tracks: number; followers: number };
}

interface ArtistDetailRow {
  id: string;
  name: string;
  verified: boolean;
  createdAt: Date;
  updatedAt: Date;
  profile: {
    bio: string | null;
    imageUrl: string | null;
    bannerUrl: string | null;
    website: string | null;
    socialLinks: Prisma.JsonValue;
  } | null;
  _count: { albums: number; tracks: number; followers: number };
}

function toDetail(row: ArtistDetailRow): ArtistDetailDto {
  return {
    id: row.id,
    name: row.name,
    verified: row.verified,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    profile: row.profile ? toProfile(row.profile) : null,
    counts: {
      albums: row._count.albums,
      tracks: row._count.tracks,
      followers: row._count.followers,
    },
  };
}

const detailInclude = {
  profile: true,
  _count: {
    select: {
      albums: { where: { deletedAt: null } },
      tracks: { where: { deletedAt: null } },
      followers: true,
    },
  },
} as const;

export interface ListArtistsQuery extends PaginationQuery {
  q?: string;
  verified?: 'true' | 'false';
}

export async function listArtists(
  query: ListArtistsQuery,
  db: Db = prisma,
): Promise<PageEnvelope<ArtistListItemDto>> {
  const p = parsePagination(query);
  const where: Prisma.ArtistWhereInput = {
    deletedAt: null,
    ...(query.verified !== undefined ? { verified: query.verified === 'true' } : {}),
    ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.artist.findMany({
      where,
      include: { _count: { select: { followers: true } } },
      orderBy: { name: 'asc' },
      skip: p.skip,
      take: p.limit,
    }),
    db.artist.count({ where }),
  ]);
  return pageEnvelope(rows.map(toListItem), total, p);
}

export async function getArtist(id: string, db: Db = prisma): Promise<ArtistDetailDto> {
  const row = await db.artist.findFirst({
    where: { id, deletedAt: null },
    include: detailInclude,
  });
  if (!row) {
    throw notFound('Artist not found.');
  }
  return toDetail(row);
}

export interface CreateArtistInput {
  name: string;
  ownerUserId?: string;
}

export async function createArtist(
  input: CreateArtistInput,
  actor: AuthUser,
  db: Db = prisma,
): Promise<ArtistDetailDto> {
  let ownerUserId = actor.id;
  if (input.ownerUserId !== undefined) {
    // Only admins may create an artist owned by someone else.
    if (!isAdmin(actor)) {
      throw forbidden('Only admins may assign an artist to a different owner.');
    }
    const owner = await db.user.findFirst({
      where: { id: input.ownerUserId, deletedAt: null },
      select: { id: true },
    });
    if (!owner) {
      throw notFound('Owner user not found.');
    }
    ownerUserId = owner.id;
  }

  const row = await db.artist.create({
    data: { name: input.name.trim(), ownerUserId },
    include: detailInclude,
  });
  return toDetail(row);
}

export interface UpdateArtistInput {
  name?: string;
  verified?: boolean;
}

export async function updateArtist(
  id: string,
  input: UpdateArtistInput,
  actor: AuthUser,
  db: Db = prisma,
): Promise<ArtistDetailDto> {
  const existing = await db.artist.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, ownerUserId: true, verified: true },
  });
  if (!existing) {
    throw notFound('Artist not found.');
  }
  if (!canManageArtist(actor, existing)) {
    throw forbidden('Only the artist owner or an admin can update this artist.');
  }
  // Verification is a moderation action, reserved for admins.
  if (input.verified !== undefined && !isAdmin(actor)) {
    throw forbidden('Only admins can change artist verification status.');
  }

  const row = await db.artist.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.verified !== undefined ? { verified: input.verified } : {}),
    },
    include: detailInclude,
  });
  // Audit verification flips only when the flag actually changes. Admin-only
  // action by the route guard, so the actor is always an admin here.
  if (input.verified !== undefined && input.verified !== existing.verified) {
    await recordAuditEvent(
      {
        actorId: actor.id,
        action: input.verified ? 'artist.verified' : 'artist.unverified',
        targetType: 'artist',
        targetId: id,
        metadata: { verified: input.verified },
      },
      db,
    );
  }
  return toDetail(row);
}

export async function deleteArtist(id: string, actor: AuthUser, db: Db = prisma): Promise<void> {
  const existing = await db.artist.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      name: true,
      ownerUserId: true,
      _count: {
        select: {
          albums: { where: { deletedAt: null } },
          tracks: { where: { deletedAt: null } },
        },
      },
    },
  });
  if (!existing) {
    throw notFound('Artist not found.');
  }
  if (!canManageArtist(actor, existing)) {
    throw forbidden('Only the artist owner or an admin can delete this artist.');
  }
  if (existing._count.albums > 0 || existing._count.tracks > 0) {
    throw conflict("Remove the artist's albums and tracks first.");
  }
  await db.artist.update({ where: { id }, data: { deletedAt: new Date() } });
  // Phase 17 — admin deletions are audited. Owner deletions are not admin
  // actions, so they write no audit row.
  if (isAdmin(actor)) {
    await recordAuditEvent(
      {
        actorId: actor.id,
        action: 'artist.deleted',
        targetType: 'artist',
        targetId: id,
        metadata: { name: existing.name },
      },
      db,
    );
  }
}

export async function getArtistProfile(
  artistId: string,
  db: Db = prisma,
): Promise<ArtistProfileDto> {
  const artist = await db.artist.findFirst({
    where: { id: artistId, deletedAt: null },
    select: { id: true },
  });
  if (!artist) {
    throw notFound('Artist not found.');
  }
  const profile = await db.artistProfile.findUnique({ where: { artistId } });
  if (!profile) {
    throw notFound('Artist profile not found.');
  }
  return toProfile(profile);
}

export interface UpsertProfileInput {
  bio?: string | null;
  imageUrl?: string | null;
  bannerUrl?: string | null;
  website?: string | null;
  socialLinks?: Prisma.InputJsonValue | null;
}

export async function upsertArtistProfile(
  artistId: string,
  input: UpsertProfileInput,
  actor: AuthUser,
  db: Db = prisma,
): Promise<ArtistProfileDto> {
  const artist = await db.artist.findFirst({
    where: { id: artistId, deletedAt: null },
    select: { id: true, ownerUserId: true },
  });
  if (!artist) {
    throw notFound('Artist not found.');
  }
  if (!canManageArtist(actor, artist)) {
    throw forbidden('Only the artist owner or an admin can update this profile.');
  }

  const data = {
    ...(input.bio !== undefined ? { bio: input.bio } : {}),
    ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
    ...(input.bannerUrl !== undefined ? { bannerUrl: input.bannerUrl } : {}),
    ...(input.website !== undefined ? { website: input.website } : {}),
    ...(input.socialLinks !== undefined ? { socialLinks: input.socialLinks ?? Prisma.DbNull } : {}),
  };
  const profile = await db.artistProfile.upsert({
    where: { artistId },
    create: { artistId, ...data },
    update: data,
  });
  return toProfile(profile);
}

/** Artists owned by the caller (any role), newest first. */
export async function listMyArtists(
  userId: string,
  query: PaginationQuery,
  db: Db = prisma,
): Promise<PageEnvelope<ArtistListItemDto>> {
  const p = parsePagination(query);
  const where: Prisma.ArtistWhereInput = { ownerUserId: userId, deletedAt: null };
  const [rows, total] = await Promise.all([
    db.artist.findMany({
      where,
      include: { _count: { select: { followers: true } } },
      orderBy: { updatedAt: 'desc' },
      skip: p.skip,
      take: p.limit,
    }),
    db.artist.count({ where }),
  ]);
  return pageEnvelope(rows.map(toListItem), total, p);
}
