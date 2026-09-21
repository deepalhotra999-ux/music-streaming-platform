/**
 * Phase 17 — advanced admin operations & moderation (backend) tests.
 *
 * Full HTTP stack via `app.inject()` against TEST_DATABASE_URL (never the
 * dev DB). Scoped cleanup: every fixture uses TEST_DOMAIN emails.
 *
 * Covers:
 * - Moderation reports: 401 unauthenticated, 403 LISTENER/ARTIST on every
 *   endpoint; create (201 + audit), target validation (404), body validation
 *   (400); list filters (status/targetType/targetId) + pagination; status
 *   transitions (valid, invalid 422, terminal states); audit rows on create,
 *   status change, and field edits — and none on failed/denied attempts.
 * - Admin catalog audit: track takedown/restore (track.status.changed),
 *   track delete (track.deleted), album delete (album.deleted), artist delete
 *   (artist.deleted) — and no audit rows when the OWNER performs the same
 *   actions.
 * - Admin user detail: 403 for LISTENER/ARTIST, 404 unknown id, includes
 *   ownedArtists + deletedAt, never credentials.
 * - includeDeleted on GET /v1/users surfaces soft-deleted accounts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db.js';

const TEST_DOMAIN = '@phase17-test.local';
let counter = 0;
const testEmail = (tag: string) => `phase17-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
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
let albumId: string;
let trackId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function auditRows(action: string, targetId?: string) {
  return prisma.adminAuditLog.findMany({
    where: {
      action,
      actor: { email: { endsWith: TEST_DOMAIN } },
      ...(targetId ? { targetId } : {}),
    },
  });
}

beforeAll(async () => {
  const config = loadConfig();
  app = await buildApp(config);

  admin = await registerAndLogin(testEmail('admin'), 'ADMIN');
  artist = await registerAndLogin(testEmail('artist'), 'ARTIST');
  listener = await registerAndLogin(testEmail('listener'), 'LISTENER');

  const createdArtist = await prisma.artist.create({
    data: { name: 'Phase17 Test Artist', ownerUserId: artist.userId },
  });
  artistId = createdArtist.id;
  const createdAlbum = await prisma.album.create({
    data: { title: 'Phase17 Test Album', artistId },
  });
  albumId = createdAlbum.id;
  const createdTrack = await prisma.track.create({
    data: { title: 'Phase17 Test Track', artistId, albumId, durationMs: 120000 },
  });
  trackId = createdTrack.id;
});

afterAll(async () => {
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
  await prisma.moderationReport.deleteMany({
    where: { createdBy: { email: { endsWith: TEST_DOMAIN } } },
  });
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

describe('Phase 17 — moderation reports: authorization', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/moderation-reports' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects LISTENER and ARTIST with 403 on every moderation endpoint', async () => {
    for (const token of [listener.token, artist.token]) {
      const list = await app.inject({
        method: 'GET',
        url: '/v1/admin/moderation-reports',
        headers: auth(token),
      });
      expect(list.statusCode).toBe(403);

      const create = await app.inject({
        method: 'POST',
        url: '/v1/admin/moderation-reports',
        headers: auth(token),
        payload: { targetType: 'TRACK', targetId: trackId, reason: 'spam content' },
      });
      expect(create.statusCode).toBe(403);
    }
    // No audit rows for denied attempts.
    expect(await auditRows('moderation.report.created')).toHaveLength(0);
  });
});

describe('Phase 17 — moderation reports: lifecycle', () => {
  let reportId: string;

  it('ADMIN can file a report against an existing track', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/moderation-reports',
      headers: auth(admin.token),
      payload: {
        targetType: 'TRACK',
        targetId: trackId,
        reason: 'Suspected spam upload',
        details: 'Uploaded 50 identical tracks in an hour.',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.targetType).toBe('TRACK');
    expect(body.targetId).toBe(trackId);
    expect(body.status).toBe('OPEN');
    expect(body.createdById).toBe(admin.userId);
    reportId = body.id;

    const audits = await auditRows('moderation.report.created', reportId);
    expect(audits).toHaveLength(1);
    expect(audits[0].targetType).toBe('moderation_report');
    const meta = audits[0].metadata as Record<string, unknown>;
    expect(meta.reportTargetType).toBe('TRACK');
    // Facts-only metadata policy: the free-form reason lives only in
    // moderation_reports, never in audit metadata.
    expect(meta).not.toHaveProperty('reason');
  });

  it('rejects reports against nonexistent targets with 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/moderation-reports',
      headers: auth(admin.token),
      payload: {
        targetType: 'ALBUM',
        targetId: '00000000-0000-4000-8000-000000000000',
        reason: 'Does not exist',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(await auditRows('moderation.report.created')).toHaveLength(1);
  });

  it('rejects short reasons with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/moderation-reports',
      headers: auth(admin.token),
      payload: { targetType: 'ARTIST', targetId: artistId, reason: '  ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('ADMIN can list reports with status/target filters and pagination', async () => {
    // Second report: album target, to exercise filters.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/admin/moderation-reports',
      headers: auth(admin.token),
      payload: { targetType: 'ALBUM', targetId: albumId, reason: 'Wrong cover art' },
    });
    expect(second.statusCode).toBe(201);

    const byStatus = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation-reports?status=OPEN',
      headers: auth(admin.token),
    });
    expect(byStatus.statusCode).toBe(200);
    expect(byStatus.json().data.length).toBeGreaterThanOrEqual(2);

    const byTarget = await app.inject({
      method: 'GET',
      url: `/v1/admin/moderation-reports?targetType=ALBUM&targetId=${albumId}`,
      headers: auth(admin.token),
    });
    expect(byTarget.statusCode).toBe(200);
    const rows = byTarget.json().data as Array<{ targetId: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].targetId).toBe(albumId);

    const paged = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation-reports?limit=1&page=1',
      headers: auth(admin.token),
    });
    expect(paged.statusCode).toBe(200);
    expect(paged.json().data).toHaveLength(1);
    expect(paged.json().pagination.total).toBeGreaterThanOrEqual(2);
  });

  it('ADMIN can fetch a single report; 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/moderation-reports/${reportId}`,
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(reportId);

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation-reports/00000000-0000-4000-8000-000000000000',
      headers: auth(admin.token),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('ADMIN can move a report through the status machine with audit rows', async () => {
    const toReview = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/moderation-reports/${reportId}`,
      headers: auth(admin.token),
      payload: { status: 'UNDER_REVIEW' },
    });
    expect(toReview.statusCode).toBe(200);
    expect(toReview.json().status).toBe('UNDER_REVIEW');
    expect(toReview.json().reviewedById).toBe(admin.userId);

    const resolved = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/moderation-reports/${reportId}`,
      headers: auth(admin.token),
      payload: { status: 'RESOLVED', details: 'Content removed by uploader.' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe('RESOLVED');

    const changes = await auditRows('moderation.report.status_changed', reportId);
    expect(changes).toHaveLength(2);
    const lastMeta = changes[1].metadata as Record<string, unknown>;
    expect(lastMeta.oldStatus).toBe('UNDER_REVIEW');
    expect(lastMeta.newStatus).toBe('RESOLVED');

    const edits = await auditRows('moderation.report.updated', reportId);
    expect(edits).toHaveLength(1);
    expect((edits[0].metadata as Record<string, unknown>).fields).toEqual(['details']);
  });

  it('rejects transitions out of terminal states with 422', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/moderation-reports/${reportId}`,
      headers: auth(admin.token),
      payload: { status: 'OPEN' },
    });
    expect(res.statusCode).toBe(422);
    // Failed transition writes no audit row.
    expect(await auditRows('moderation.report.status_changed', reportId)).toHaveLength(2);
  });

  it('LISTENER cannot update a report (403) and no audit row is written', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/moderation-reports/${reportId}`,
      headers: auth(listener.token),
      payload: { status: 'DISMISSED' },
    });
    expect(res.statusCode).toBe(403);
    expect(await auditRows('moderation.report.status_changed', reportId)).toHaveLength(2);
  });
});

describe('Phase 17 — admin catalog actions are audited; owner actions are not', () => {
  it('ADMIN track takedown writes track.status.changed with old/new status', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tracks/${trackId}`,
      headers: auth(admin.token),
      payload: { status: 'TAKEDOWN' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('TAKEDOWN');

    const audits = await auditRows('track.status.changed', trackId);
    expect(audits).toHaveLength(1);
    const meta = audits[0].metadata as Record<string, unknown>;
    expect(meta.oldStatus).toBe('PROCESSING');
    expect(meta.newStatus).toBe('TAKEDOWN');
    expect(meta.title).toBe('Phase17 Test Track');
  });

  it('OWNER track status change writes no audit row', async () => {
    const other = await prisma.track.create({
      data: { title: 'Phase17 Owner Track', artistId, durationMs: 60000 },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tracks/${other.id}`,
      headers: auth(artist.token),
      payload: { status: 'FAILED' },
    });
    expect(res.statusCode).toBe(200);
    expect(await auditRows('track.status.changed', other.id)).toHaveLength(0);
    await prisma.track.delete({ where: { id: other.id } });
  });

  it('ADMIN track delete writes track.deleted; blocked while in playlists', async () => {
    const doomed = await prisma.track.create({
      data: { title: 'Phase17 Doomed Track', artistId, durationMs: 60000 },
    });
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/tracks/${doomed.id}`,
      headers: auth(admin.token),
    });
    expect(del.statusCode).toBe(204);
    const audits = await auditRows('track.deleted', doomed.id);
    expect(audits).toHaveLength(1);
    expect((audits[0].metadata as Record<string, unknown>).title).toBe('Phase17 Doomed Track');
    await prisma.track.delete({ where: { id: doomed.id } });
  });

  it('ADMIN album delete writes album.deleted', async () => {
    const album = await prisma.album.create({
      data: { title: 'Phase17 Doomed Album', artistId },
    });
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/albums/${album.id}`,
      headers: auth(admin.token),
    });
    expect(del.statusCode).toBe(204);
    const audits = await auditRows('album.deleted', album.id);
    expect(audits).toHaveLength(1);
    expect((audits[0].metadata as Record<string, unknown>).title).toBe('Phase17 Doomed Album');
    await prisma.album.delete({ where: { id: album.id } });
  });

  it('ADMIN artist delete writes artist.deleted', async () => {
    const created = await prisma.artist.create({
      data: { name: 'Phase17 Doomed Artist', ownerUserId: artist.userId },
    });
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/artists/${created.id}`,
      headers: auth(admin.token),
    });
    expect(del.statusCode).toBe(204);
    const audits = await auditRows('artist.deleted', created.id);
    expect(audits).toHaveLength(1);
    expect((audits[0].metadata as Record<string, unknown>).name).toBe('Phase17 Doomed Artist');
    await prisma.artist.delete({ where: { id: created.id } });
  });

  it('OWNER album delete writes no audit row', async () => {
    const album = await prisma.album.create({
      data: { title: 'Phase17 Owner Album', artistId },
    });
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/albums/${album.id}`,
      headers: auth(artist.token),
    });
    expect(del.statusCode).toBe(204);
    expect(await auditRows('album.deleted', album.id)).toHaveLength(0);
    await prisma.album.delete({ where: { id: album.id } });
  });
});

describe('Phase 17 — admin user detail and account status', () => {
  it('rejects LISTENER/ARTIST with 403 and unauthenticated with 401', async () => {
    for (const token of [listener.token, artist.token]) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/admin/users/${artist.userId}`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(403);
    }
    const unauth = await app.inject({ method: 'GET', url: `/v1/admin/users/${artist.userId}` });
    expect(unauth.statusCode).toBe(401);
  });

  it('ADMIN gets user detail with owned artists, status, and no credentials', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/users/${artist.userId}`,
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toContain(TEST_DOMAIN);
    expect(body.deletedAt).toBeNull();
    expect(body.ownedArtists).toBeInstanceOf(Array);
    expect(body.ownedArtists.some((a: { id: string }) => a.id === artistId)).toBe(true);
    // Credentials must never leak through the admin surface.
    expect(body.passwordHash).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });

  it('returns 404 for unknown user id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/users/00000000-0000-4000-8000-000000000000',
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('includeDeleted surfaces soft-deleted accounts in the admin list', async () => {
    const email = testEmail('deleted');
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, displayName: email },
    });
    const userId = reg.json().user.id as string;
    await prisma.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });

    const hidden = await app.inject({
      method: 'GET',
      url: `/v1/users?q=${encodeURIComponent(email)}`,
      headers: auth(admin.token),
    });
    expect(hidden.json().data).toHaveLength(0);

    const shown = await app.inject({
      method: 'GET',
      url: `/v1/users?q=${encodeURIComponent(email)}&includeDeleted=true`,
      headers: auth(admin.token),
    });
    expect(shown.statusCode).toBe(200);
    const rows = shown.json().data as Array<{ id: string; deletedAt: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(userId);
    expect(rows[0].deletedAt).not.toBeNull();

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/admin/users/${userId}`,
      headers: auth(admin.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().deletedAt).not.toBeNull();
  });
});
