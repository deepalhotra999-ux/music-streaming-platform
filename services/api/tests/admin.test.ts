/**
 * Phase 16 — admin panel foundation (backend) tests.
 *
 * Full HTTP stack via `app.inject()` against TEST_DATABASE_URL (never the
 * dev DB). Scoped cleanup: every fixture uses TEST_DOMAIN emails.
 *
 * Covers: ADMIN user listing (search + pagination), 403 for LISTENER/ARTIST
 * and 401 unauthenticated on the admin surface (/v1/users,
 * /v1/admin/audit-logs, /v1/analytics/platform/overview), audit rows written
 * on admin role changes and artist verification flips (and not written on
 * failed/forbidden attempts), DB-trigger immutability of audit rows
 * (update/delete must throw), audit listing + action filter, artist listing
 * with the verified filter, and track listing with the status filter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db.js';

const TEST_DOMAIN = '@admin-test.local';
let counter = 0;
const testEmail = (tag: string) => `phase16-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;

type Role = 'LISTENER' | 'ARTIST' | 'ADMIN';

async function registerAndLogin(
  email: string,
  role: Role,
): Promise<{ userId: string; token: string }> {
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, displayName: email },
  });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().user.id as string;
  if (role !== 'LISTENER') {
    await prisma.user.update({ where: { id: userId }, data: { role } });
  }
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  return { userId, token: login.json().tokens.accessToken as string };
}

let admin: { userId: string; token: string };
let artist: { userId: string; token: string };
let listener: { userId: string; token: string };
let artistId: string;

beforeAll(async () => {
  const config = loadConfig();
  app = await buildApp(config);

  admin = await registerAndLogin(testEmail('admin'), 'ADMIN');
  artist = await registerAndLogin(testEmail('artist'), 'ARTIST');
  listener = await registerAndLogin(testEmail('listener'), 'LISTENER');

  const created = await prisma.artist.create({
    data: { name: `Phase16 Test Artist`, ownerUserId: artist.userId },
  });
  artistId = created.id;
});

afterAll(async () => {
  // Scoped cleanup: only rows created by this suite. Every audit row written
  // here was recorded by the suite's admin actor. The immutability trigger
  // blocks DELETEs, so the suite disables it just for its own cleanup and
  // re-enables it immediately after.
  await prisma.$executeRawUnsafe(
    'ALTER TABLE admin_audit_logs DISABLE TRIGGER admin_audit_logs_no_mutation',
  );
  try {
    await prisma.adminAuditLog.deleteMany({
      where: { actor: { email: { endsWith: TEST_DOMAIN } } },
    });
  } finally {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE admin_audit_logs ENABLE TRIGGER admin_audit_logs_no_mutation',
    );
  }
  await prisma.track.deleteMany({
    where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.album.deleteMany({
    where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.artist.deleteMany({ where: { owner: { email: { endsWith: TEST_DOMAIN } } } });
  await prisma.refreshToken.deleteMany({ where: { user: { email: { endsWith: TEST_DOMAIN } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
  await app.close();
});

describe('Phase 16 — admin panel foundation', () => {
  it('ADMIN can list users with search and pagination', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/users?q=phase16&limit=2&page=1`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeInstanceOf(Array);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(2);
    expect(body.pagination.total).toBeGreaterThanOrEqual(3);
    expect(body.data.every((u: { email: string }) => u.email.includes('phase16'))).toBe(true);

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/users?q=phase16&limit=2&page=2`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().pagination.page).toBe(2);
  });

  it('ADMIN can filter users by role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/users?role=ARTIST&q=phase16`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.every((u: { role: string }) => u.role === 'ARTIST')).toBe(true);
  });

  it('LISTENER and ARTIST get 403 on admin endpoints', async () => {
    for (const token of [listener.token, artist.token]) {
      for (const url of ['/v1/users', '/v1/admin/audit-logs', '/v1/analytics/platform/overview']) {
        const res = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().type).toContain('forbidden');
      }
    }
  });

  it('unauthenticated requests get 401 on admin endpoints', async () => {
    for (const url of ['/v1/users', '/v1/admin/audit-logs', '/v1/analytics/platform/overview']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('ADMIN can read the platform analytics overview', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/analytics/platform/overview?range=7d',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('range', '7d');
  });

  it('PATCH /v1/users/:id/role as ADMIN writes a user.role.changed audit row', async () => {
    const targetEmail = testEmail('role-target');
    const { userId, token } = await registerAndLogin(targetEmail, 'LISTENER');
    expect(token).toBeTruthy();

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${userId}/role`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { role: 'ARTIST' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('ARTIST');

    const row = await prisma.adminAuditLog.findFirst({
      where: { action: 'user.role.changed', targetId: userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row!.actorId).toBe(admin.userId);
    expect(row!.targetType).toBe('user');
    expect(row!.metadata).toMatchObject({ oldRole: 'LISTENER', newRole: 'ARTIST' });
  });

  it('ADMIN cannot change their own role (no audit row)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${admin.userId}/role`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { role: 'LISTENER' },
    });
    expect(res.statusCode).toBe(403);

    const rows = await prisma.adminAuditLog.count({
      where: { action: 'user.role.changed', targetId: admin.userId },
    });
    expect(rows).toBe(0);
  });

  it('PATCH /v1/artists/:id {verified:true} as ADMIN writes an artist.verified audit row', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/artists/${artistId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { verified: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(true);

    const row = await prisma.adminAuditLog.findFirst({
      where: { action: 'artist.verified', targetId: artistId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row!.actorId).toBe(admin.userId);
    expect(row!.targetType).toBe('artist');
    expect(row!.metadata).toMatchObject({ verified: true });
  });

  it('ADMIN un-verifying an artist writes an artist.unverified audit row', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/artists/${artistId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { verified: false },
    });
    expect(res.statusCode).toBe(200);

    const row = await prisma.adminAuditLog.findFirst({
      where: { action: 'artist.unverified', targetId: artistId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row!.metadata).toMatchObject({ verified: false });
  });

  it('PATCH with verified unchanged writes no audit row', async () => {
    const before = await prisma.adminAuditLog.count({
      where: { targetId: artistId, action: { startsWith: 'artist.' } },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/artists/${artistId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'Phase16 Renamed Artist' },
    });
    expect(res.statusCode).toBe(200);
    const after = await prisma.adminAuditLog.count({
      where: { targetId: artistId, action: { startsWith: 'artist.' } },
    });
    expect(after).toBe(before);
  });

  it('LISTENER verify attempt gets 403 and writes no audit row', async () => {
    const before = await prisma.adminAuditLog.count({
      where: { targetId: artistId, action: { startsWith: 'artist.' } },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/artists/${artistId}`,
      headers: { authorization: `Bearer ${listener.token}` },
      payload: { verified: true },
    });
    expect(res.statusCode).toBe(403);
    const after = await prisma.adminAuditLog.count({
      where: { targetId: artistId, action: { startsWith: 'artist.' } },
    });
    expect(after).toBe(before);
  });

  it('audit rows cannot be updated (trigger rejects)', async () => {
    const row = await prisma.adminAuditLog.create({
      data: {
        actorId: admin.userId,
        action: 'test.immutable',
        targetType: 'test',
        metadata: {},
      },
    });
    await expect(
      prisma.adminAuditLog.update({
        where: { id: row.id },
        data: { action: 'test.mutated' },
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it('audit rows cannot be deleted (trigger rejects)', async () => {
    await expect(
      prisma.adminAuditLog.deleteMany({ where: { action: 'test.immutable' } }),
    ).rejects.toThrow(/append-only/i);
  });

  it('GET /v1/admin/audit-logs as ADMIN returns rows with pagination and action filter', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-logs?limit=5',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.pagination.limit).toBe(5);
    expect(body.pagination.total).toBeGreaterThanOrEqual(1);
    const row = body.data[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('action');
    expect(row).toHaveProperty('targetType');
    expect(row).toHaveProperty('createdAt');

    const filtered = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-logs?action=user.role.changed',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(filtered.statusCode).toBe(200);
    const fbody = filtered.json();
    expect(fbody.pagination.total).toBeGreaterThanOrEqual(1);
    expect(fbody.data.every((r: { action: string }) => r.action === 'user.role.changed')).toBe(
      true,
    );
    // Regression: audit metadata must survive HTTP serialization (a bare
    // `{ type: 'object' }` response schema made fast-json-stringify emit {}).
    const withMeta = fbody.data.find(
      (r: { metadata?: Record<string, unknown> }) => r.metadata?.oldRole === 'LISTENER',
    );
    expect(withMeta).toBeDefined();
    expect(withMeta.metadata).toMatchObject({ oldRole: 'LISTENER', newRole: 'ARTIST' });
    expect(withMeta.actorId).toBe(admin.userId);
    expect(withMeta.targetType).toBe('user');
    expect(withMeta.targetId).toBeTruthy();
  });

  it('artist listing supports the verified filter', async () => {
    // artistId was verified then un-verified above; currently verified=false.
    const verified = await app.inject({
      method: 'GET',
      url: `/v1/artists?verified=true&q=Phase16`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().data.every((a: { verified: boolean }) => a.verified === true)).toBe(
      true,
    );

    const unverified = await app.inject({
      method: 'GET',
      url: `/v1/artists?verified=false&q=Phase16`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(unverified.statusCode).toBe(200);
    const ids = unverified.json().data.map((a: { id: string }) => a.id) as string[];
    expect(ids).toContain(artistId);
  });

  it('track listing supports the status filter', async () => {
    await prisma.track.create({
      data: {
        title: 'Phase16 Status Filter Track',
        artistId,
        durationMs: 120000,
        status: 'READY',
      },
    });
    const ready = await app.inject({
      method: 'GET',
      url: '/v1/tracks?status=READY&q=Phase16',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().data.every((t: { status: string }) => t.status === 'READY')).toBe(true);
    expect(ready.json().data.length).toBeGreaterThanOrEqual(1);

    const processing = await app.inject({
      method: 'GET',
      url: '/v1/tracks?status=PROCESSING&q=Phase16',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(processing.statusCode).toBe(200);
    expect(processing.json().data.length).toBe(0);
  });

  it('no mutation routes exist on the audit resource', async () => {
    for (const token of [listener.token, artist.token, admin.token]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/audit-logs',
        headers: { authorization: `Bearer ${token}` },
        payload: { action: 'test.forge' },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});
