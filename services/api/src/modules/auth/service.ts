// Phase 3 — authentication. Domain logic for registration, login, refresh,
// and logout. Pure Prisma + crypto: no HTTP concerns here (routes map the
// domain errors below to RFC 7807 problems).

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import type { Config } from '../../config.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { createAccessToken, hashRefreshToken, newRefreshToken } from './tokens.js';

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`An account already exists for ${email}.`);
    this.name = 'DuplicateEmailError';
  }
}

/**
 * Deliberately coarse: unknown email, wrong password, and passwordless
 * (social) accounts all surface identically so callers cannot enumerate users.
 */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Email or password is incorrect.');
    this.name = 'InvalidCredentialsError';
  }
}

/** Unknown, expired, revoked, or reused refresh token — all look the same. */
export class InvalidRefreshTokenError extends Error {
  constructor() {
    super('Refresh token is invalid or expired.');
    this.name = 'InvalidRefreshTokenError';
  }
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'LISTENER' | 'ARTIST' | 'ADMIN';
  emailVerified: boolean;
  countryCode: string | null;
  createdAt: Date;
}

export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  /** seconds until the access token expires */
  expiresIn: number;
}

export interface AuthResult {
  user: PublicUser;
  tokens: TokenPair;
}

type Db = PrismaClient;

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'LISTENER' | 'ARTIST' | 'ADMIN';
  emailVerified: boolean;
  countryCode: string | null;
  createdAt: Date;
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    role: row.role,
    emailVerified: row.emailVerified,
    countryCode: row.countryCode,
    createdAt: row.createdAt,
  };
}

async function issueTokenPair(
  db: Db,
  user: UserRow,
  config: Config,
): Promise<{ tokens: TokenPair; publicUser: PublicUser }> {
  const publicUser = toPublicUser(user);
  const accessToken = await createAccessToken(publicUser, config);

  const refreshToken = newRefreshToken();
  await db.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + config.refreshTokenTtlSeconds * 1000),
    },
  });

  return {
    publicUser,
    tokens: {
      tokenType: 'Bearer',
      accessToken,
      refreshToken,
      expiresIn: config.accessTokenTtlSeconds,
    },
  };
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
}

export async function register(
  input: RegisterInput,
  config: Config,
  db: Db = prisma,
): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    throw new DuplicateEmailError(email);
  }

  let user;
  try {
    user = await db.user.create({
      data: {
        email,
        passwordHash: await hashPassword(input.password),
        displayName: input.displayName.trim(),
        role: 'LISTENER',
      },
    });
  } catch (err) {
    // Lost a race with a concurrent registration for the same email.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new DuplicateEmailError(email);
    }
    throw err;
  }

  const { publicUser, tokens } = await issueTokenPair(db, user, config);
  return { user: publicUser, tokens };
}

export interface LoginInput {
  email: string;
  password: string;
}

export async function login(
  input: LoginInput,
  config: Config,
  db: Db = prisma,
): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();

  const user = await db.user.findUnique({ where: { email } });
  // Same observable outcome for unknown email, deleted account, passwordless
  // account, and wrong password: no user enumeration.
  if (!user || user.deletedAt || !user.passwordHash) {
    throw new InvalidCredentialsError();
  }
  if (!(await verifyPassword(user.passwordHash, input.password))) {
    throw new InvalidCredentialsError();
  }

  const { publicUser, tokens } = await issueTokenPair(db, user, config);
  return { user: publicUser, tokens };
}

export async function refresh(
  refreshToken: string,
  config: Config,
  db: Db = prisma,
): Promise<AuthResult> {
  const tokenHash = hashRefreshToken(refreshToken);
  const row = await db.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!row || row.expiresAt.getTime() <= Date.now()) {
    if (row) {
      // Hygiene: drop expired rows when we trip over them. (No background
      // purge yet — see phase report known issues.)
      await db.refreshToken.delete({ where: { id: row.id } }).catch(() => undefined);
    }
    throw new InvalidRefreshTokenError();
  }

  if (row.revokedAt) {
    if (row.replacedAt) {
      // Reuse of an already-rotated token: suspected theft. Nuke the whole
      // family so a stolen chain cannot keep yielding fresh tokens.
      await db.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    throw new InvalidRefreshTokenError();
  }

  if (!row.user || row.user.deletedAt) {
    throw new InvalidRefreshTokenError();
  }

  // Rotate atomically: revoke the presented token and mint its replacement in
  // one transaction so a crash cannot leave two live tokens from one refresh.
  const newToken = newRefreshToken();
  const newAccessToken = await createAccessToken(toPublicUser(row.user), config);
  const now = new Date();
  await db.$transaction([
    db.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: now, replacedAt: now },
    }),
    db.refreshToken.create({
      data: {
        userId: row.userId,
        tokenHash: hashRefreshToken(newToken),
        expiresAt: new Date(now.getTime() + config.refreshTokenTtlSeconds * 1000),
      },
    }),
  ]);

  return {
    user: toPublicUser(row.user),
    tokens: {
      tokenType: 'Bearer',
      accessToken: newAccessToken,
      refreshToken: newToken,
      expiresIn: config.accessTokenTtlSeconds,
    },
  };
}

/**
 * Idempotent: unknown or already-revoked tokens still succeed. Clients must
 * not be able to probe which tokens are live.
 */
export async function logout(refreshToken: string, db: Db = prisma): Promise<void> {
  await db.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
