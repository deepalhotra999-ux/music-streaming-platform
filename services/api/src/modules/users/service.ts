// Phase 4 — users. Domain logic: admin listing, public profiles, self
// profile updates, and admin role changes. Throws HttpProblem errors (see
// http/errors.ts) which the central handler renders as RFC 7807.

import type { PrismaClient, UserRole } from '@prisma/client';
import { prisma } from '../../db.js';
import { badRequest, notFound } from '../../http/errors.js';
import type { AuthUser } from '../../http/auth.js';
import {
  pageEnvelope,
  parsePagination,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';

type Db = PrismaClient;

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: UserRole;
  emailVerified: boolean;
  countryCode: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface PublicUserDto {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: UserRole;
  emailVerified: boolean;
  countryCode: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

function toPublicUser(row: UserRow): PublicUserDto {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    role: row.role,
    emailVerified: row.emailVerified,
    countryCode: row.countryCode,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

export interface UserProfileDto extends Omit<PublicUserDto, 'email' | 'emailVerified' | 'deletedAt'> {
  email?: string;
}

function toProfile(row: UserRow, viewer: AuthUser): UserProfileDto {
  const profile: UserProfileDto = {
    id: row.id,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    role: row.role,
    countryCode: row.countryCode,
    createdAt: row.createdAt,
  };
  // Email is PII: only the account holder and admins may see it.
  if (viewer.id === row.id || viewer.role === 'ADMIN') {
    profile.email = row.email;
  }
  return profile;
}

export interface ListUsersQuery extends PaginationQuery {
  q?: string;
  role?: UserRole;
  // Phase 17 — admin-only. The /v1/users list route is ADMIN-only, so this
  // flag is safe here: it lets operators see soft-deleted accounts.
  includeDeleted?: boolean;
}

export async function listUsers(
  query: ListUsersQuery,
  db: Db = prisma,
): Promise<PageEnvelope<PublicUserDto>> {
  const p = parsePagination(query);
  const where = {
    ...(query.includeDeleted ? {} : { deletedAt: null }),
    ...(query.role ? { role: query.role } : {}),
    ...(query.q
      ? {
          OR: [
            { displayName: { contains: query.q, mode: 'insensitive' as const } },
            { email: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.limit,
    }),
    db.user.count({ where }),
  ]);
  return pageEnvelope(rows.map(toPublicUser), total, p);
}

export async function getUserProfile(
  id: string,
  viewer: AuthUser,
  db: Db = prisma,
): Promise<UserProfileDto> {
  const row = await db.user.findFirst({ where: { id, deletedAt: null } });
  if (!row) {
    throw notFound('User not found.');
  }
  return toProfile(row, viewer);
}

export interface AdminUserDetailDto extends PublicUserDto {
  updatedAt: Date;
  ownedArtists: Array<{
    id: string;
    name: string;
    verified: boolean;
    createdAt: Date;
  }>;
}

/**
 * Phase 17 — admin-only user detail for the operations console. Includes
 * account status (deletedAt) and the artists the user owns. Never includes
 * credentials: the select below is explicit and excludes passwordHash,
 * tokens, and secrets by construction.
 */
export async function getAdminUserDetail(
  id: string,
  db: Db = prisma,
): Promise<AdminUserDetailDto> {
  const row = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      role: true,
      emailVerified: true,
      countryCode: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
      artists: {
        where: { deletedAt: null },
        select: { id: true, name: true, verified: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!row) {
    throw notFound('User not found.');
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    role: row.role,
    emailVerified: row.emailVerified,
    countryCode: row.countryCode,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
    updatedAt: row.updatedAt,
    ownedArtists: row.artists,
  };
}

export interface UpdateMeInput {
  displayName?: string;
  avatarUrl?: string | null;
  countryCode?: string | null;
}

export async function updateMe(
  userId: string,
  input: UpdateMeInput,
  db: Db = prisma,
): Promise<PublicUserDto> {
  const data: {
    displayName?: string;
    avatarUrl?: string | null;
    countryCode?: string | null;
  } = {};
  if (input.displayName !== undefined) data.displayName = input.displayName.trim();
  if (input.avatarUrl !== undefined) data.avatarUrl = input.avatarUrl;
  if (input.countryCode !== undefined) {
    data.countryCode = input.countryCode === null ? null : input.countryCode.toUpperCase();
  }
  if (Object.keys(data).length === 0) {
    throw badRequest('Nothing to update.');
  }
  const row = await db.user.update({ where: { id: userId }, data });
  return toPublicUser(row);
}
