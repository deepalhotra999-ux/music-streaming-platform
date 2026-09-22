/**
 * Phase 27 — collaborative playlists backend tests.
 *
 * Full HTTP stack via `app.inject()` against TEST_DATABASE_URL (never the
 * dev DB), following the conventions of tests/phase4.test.ts.
 *
 * Covers:
 * - Collaboration settings (owner-only enable/disable; 404 for non-owners so
 *   private playlists stay hidden).
 * - Optimistic concurrency: expectedRevision required on collaborative track
 *   mutations, stale writes get RFC 7807 409 with no silent overwrite, the
 *   new revision is returned in the x-playlist-revision header, and
 *   revision bump + mutation + history row are atomic.
 * - Membership: owner-managed invites/leave/remove, editor track rights,
 *   immediate access loss on removal/leave.
 * - Invitations: single-use, expiring, revocable bearer tokens; only the
 *   SHA-256 hash is stored; the raw token is returned exactly once.
 * - Change history: append-only (DB trigger rejects UPDATE/DELETE), readable
 *   by members only.
 * - Privacy: private collaborative playlists never leak via public listings,
 *   detail reads, member/change endpoints, or discovery; collaboration never
 *   grants playback entitlement.
 * - Spoof prevention: no endpoint accepts client-supplied actor/owner/member
 *   ids (strict additionalProperties: false schemas).
 *
 * Cleanup is scoped to `@phase27-test.local` addresses so suites sharing the
 * test database never touch each other's rows (files run sequentially).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { prisma } from '../src/db.js';

const TEST_DOMAIN = '@phase27-test.local';
let counter = 0;
const testEmail = (tag: string) => `phase27-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;
let config: Config;

/** FK-safe cleanup, children before parents, scoped to this suite's domain.
 * playlist_changes is append-only: the DB trigger rejects DELETE (even via
 * FK cascades), so the trigger is disabled for the scoped cleanup and
 * re-enabled afterwards — the same pattern phase4.test.ts uses for
 * admin_audit_logs. */
async function scopedClean(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'ALTER TABLE playlist_changes DISABLE TRIGGER playlist_changes_no_mutation',
  );
  try {
    const byPlaylistOwner = { playlist: { owner: { email: { endsWith: TEST_DOMAIN } } } };
    await prisma.playlistChange.deleteMany({ where: byPlaylistOwner });
    await prisma.playlistInvitation.deleteMany({ where: byPlaylistOwner });
    await prisma.playlistMember.deleteMany({ where: byPlaylistOwner });
    await prisma.playlistTrack.deleteMany({ where: byPlaylistOwner });
    await prisma.playlist.deleteMany({ where: { owner: { email: { endsWith: TEST_DOMAIN } } } });
    await prisma.track.deleteMany({
      where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
    });
    await prisma.artist.deleteMany({ where: { owner: { email: { endsWith: TEST_DOMAIN } } } });
    await prisma.refreshToken.deleteMany({ where: { user: { email: { endsWith: TEST_DOMAIN } } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
  } finally {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE playlist_changes ENABLE TRIGGER playlist_changes_no_mutation',
    );
  }
}

beforeAll(async () => {
  config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    RATE_LIMIT_LOGIN: '1000',
    RATE_LIMIT_REGISTER: '1000',
    RATE_LIMIT_REFRESH: '1000',
    RATE_LIMIT_LOGOUT: '1000',
    RATE_LIMIT_API: '10000',
  });
  app = await buildApp(config);
  await scopedClean();
});

afterAll(async () => {
  await scopedClean();
  await app.close();
  await prisma.$disconnect();
});

interface TestUser {
  id: string;
  email: string;
  authToken: string;
}

async function createUser(tag: string): Promise<TestUser> {
  const email = testEmail(tag);
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, displayName: `${tag} User` },
  });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().user.id as string;
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  return { id: userId, email, authToken: login.json().tokens.accessToken as string };
}

const auth = (user: TestUser) => ({ authorization: `Bearer ${user.authToken}` });

function expectProblemJson(res: { headers: Record<string, unknown> }) {
  expect(String(res.headers['content-type'])).toMatch('application/problem+json');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let owner: TestUser;
let editor: TestUser;
let stranger: TestUser;
let artistId: string;
let trackIds: string[] = [];

async function createPlaylist(
  user: TestUser,
  title: string,
  visibility: 'PRIVATE' | 'PUBLIC' | 'UNLISTED' = 'PRIVATE',
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/playlists',
    headers: auth(user),
    payload: { title, visibility },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function enableCollaboration(user: TestUser, playlistId: string): Promise<number> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/playlists/${playlistId}/collaboration`,
    headers: auth(user),
    payload: { isCollaborative: true },
  });
  expect(res.statusCode).toBe(200);
  return res.json().revision as number;
}

async function createInvitationRaw(user: TestUser, playlistId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/playlists/${playlistId}/invitations`,
    headers: auth(user),
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token as string, invitationId: body.invitation.id as string };
}

beforeAll(async () => {
  owner = await createUser('owner');
  editor = await createUser('editor');
  stranger = await createUser('stranger');

  const artist = await prisma.artist.create({
    data: { name: 'Phase27 Test Artist', ownerUserId: owner.id },
  });
  artistId = artist.id;
  const tracks = await Promise.all(
    ['Phase27 Track One', 'Phase27 Track Two', 'Phase27 Track Three'].map((title) =>
      prisma.track.create({ data: { title, artistId: artist.id, durationMs: 180_000 } }),
    ),
  );
  trackIds = tracks.map((t) => t.id);
}, 120_000);

// ---------------------------------------------------------------------------
// Collaboration settings
// ---------------------------------------------------------------------------

describe('PATCH /v1/playlists/:id/collaboration', () => {
  it('owner can enable collaboration; response carries isCollaborative + revision', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Settings One');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/collaboration`,
      headers: auth(owner),
      payload: { isCollaborative: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isCollaborative).toBe(true);
    expect(body.revision).toBe(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(owner),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().isCollaborative).toBe(true);
    expect(detail.json().revision).toBe(1);
    expect(detail.json().viewerRole).toBe('OWNER');
  });

  it('rejects enabling collaboration twice without bumping the revision', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Settings Two');
    const first = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/collaboration`,
      headers: auth(owner),
      payload: { isCollaborative: true },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/collaboration`,
      headers: auth(owner),
      payload: { isCollaborative: true },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().revision).toBe(first.json().revision);
  });

  it('editor cannot change collaboration settings (404, no existence leak)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Settings Three');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    const accept = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    expect(accept.statusCode).toBe(200);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/collaboration`,
      headers: auth(editor),
      payload: { isCollaborative: false },
    });
    expect(res.statusCode).toBe(404);
    expectProblemJson(res);
  });

  it('non-member cannot change collaboration settings (404)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Settings Four');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/collaboration`,
      headers: auth(stranger),
      payload: { isCollaborative: false },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects collaboration toggle on a missing playlist (404)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/playlists/00000000-0000-0000-0000-000000000000/collaboration',
      headers: auth(owner),
      payload: { isCollaborative: true },
    });
    expect(res.statusCode).toBe(404);
  });
});
// ---------------------------------------------------------------------------
// Optimistic concurrency on track mutations
// ---------------------------------------------------------------------------

describe('collaborative track mutations with expectedRevision', () => {
  it('requires expectedRevision on add (400 when missing)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Rev One');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(owner),
      payload: { trackId: trackIds[0] },
    });
    expect(res.statusCode).toBe(400);
    expectProblemJson(res);
  });

  it('add with the current revision succeeds and returns x-playlist-revision', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Rev Two');
    const revision = await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(owner),
      payload: { trackId: trackIds[0], expectedRevision: revision },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-playlist-revision']).toBe(String(revision + 1));
    expect(res.json().track.id).toBe(trackIds[0]);
  });

  it('stale revision add fails with RFC 7807 409 and changes nothing', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Rev Three');
    const revision = await enableCollaboration(owner, playlistId);

    const first = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(owner),
      payload: { trackId: trackIds[0], expectedRevision: revision },
    });
    expect(first.statusCode).toBe(201);
    const currentRevision = Number(first.headers['x-playlist-revision']);

    const stale = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(owner),
      payload: { trackId: trackIds[1], expectedRevision: revision },
    });
    expect(stale.statusCode).toBe(409);
    expectProblemJson(stale);

    // No silent overwrite: revision, item count, and history are unchanged.
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(owner),
    });
    expect(detail.json().revision).toBe(currentRevision);
    expect(detail.json().items).toHaveLength(1);
    expect(detail.json().items[0].track.id).toBe(trackIds[0]);
  });

  it('concurrent adds with the same revision: exactly one wins, the other gets 409', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Race One');
    const revision = await enableCollaboration(owner, playlistId);

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/v1/playlists/${playlistId}/tracks`,
        headers: auth(owner),
        payload: { trackId: trackIds[0], expectedRevision: revision },
      }),
      app.inject({
        method: 'POST',
        url: `/v1/playlists/${playlistId}/tracks`,
        headers: auth(owner),
        payload: { trackId: trackIds[1], expectedRevision: revision },
      }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    expectProblemJson(a.statusCode === 409 ? a : b);

    // The revision advanced exactly once; only the winner's track is present.
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(owner),
    });
    expect(detail.json().revision).toBe(revision + 1);
    expect(detail.json().items).toHaveLength(1);
    const winnerTrackId = a.statusCode === 201 ? trackIds[0] : trackIds[1];
    expect(detail.json().items[0].track.id).toBe(winnerTrackId);
  });

  it('editor can add/move/remove tracks with the current revision', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Rev Four');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const beforeAdd = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(editor),
    });
    const revision = beforeAdd.json().revision as number;

    const add = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(editor),
      payload: { trackId: trackIds[0], expectedRevision: revision },
    });
    expect(add.statusCode).toBe(201);
    const rev1 = Number(add.headers['x-playlist-revision']);
    const itemId = add.json().id as string;

    const move = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/tracks/${itemId}`,
      headers: auth(editor),
      payload: { position: 10, expectedRevision: rev1 },
    });
    expect(move.statusCode).toBe(200);
    const rev2 = Number(move.headers['x-playlist-revision']);
    expect(move.json().position).toBe(10);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/tracks/${itemId}`,
      headers: auth(editor),
      payload: { expectedRevision: rev2 },
    });
    expect(remove.statusCode).toBe(204);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(owner),
    });
    expect(detail.json().items).toHaveLength(0);
  });

  it('move and remove require expectedRevision (400) and reject stale revisions (409)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Rev Five');
    const revision = await enableCollaboration(owner, playlistId);
    const add = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(owner),
      payload: { trackId: trackIds[0], expectedRevision: revision },
    });
    const itemId = add.json().id as string;
    const rev1 = Number(add.headers['x-playlist-revision']);

    const moveMissing = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/tracks/${itemId}`,
      headers: auth(owner),
      payload: { position: 5 },
    });
    expect(moveMissing.statusCode).toBe(400);

    const moveStale = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/tracks/${itemId}`,
      headers: auth(owner),
      payload: { position: 5, expectedRevision: revision },
    });
    expect(moveStale.statusCode).toBe(409);
    expectProblemJson(moveStale);

    const removeMissing = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/tracks/${itemId}`,
      headers: auth(owner),
      payload: {},
    });
    expect(removeMissing.statusCode).toBe(400);

    const removeStale = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/tracks/${itemId}`,
      headers: auth(owner),
      payload: { expectedRevision: revision },
    });
    expect(removeStale.statusCode).toBe(409);

    // The item is untouched: still at its original position.
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(owner),
    });
    expect(detail.json().revision).toBe(rev1);
    expect(detail.json().items).toHaveLength(1);
    expect(detail.json().items[0].position).not.toBe(5);
  });

  it('non-member write on a private collaborative playlist is 404', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Rev Six');
    const revision = await enableCollaboration(owner, playlistId);
    for (const method of ['POST'] as const) {
      const res = await app.inject({
        method,
        url: `/v1/playlists/${playlistId}/tracks`,
        headers: auth(stranger),
        payload: { trackId: trackIds[0], expectedRevision: revision },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('non-collaborative owner writes still work without a revision', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Legacy One');
    const add = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(owner),
      payload: { trackId: trackIds[0] },
    });
    expect(add.statusCode).toBe(201);
    const itemId = add.json().id as string;

    const move = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/tracks/${itemId}`,
      headers: auth(owner),
      payload: { position: 7 },
    });
    expect(move.statusCode).toBe(200);
    expect(move.json().position).toBe(7);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/tracks/${itemId}`,
      headers: auth(owner),
    });
    expect(remove.statusCode).toBe(204);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(owner),
    });
    expect(detail.json().revision).toBe(0);
    expect(detail.json().isCollaborative).toBe(false);
  });

  it('failed mutation (unknown track) leaves the revision unchanged — no partial write', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Rev Seven');
    const revision = await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(owner),
      payload: {
        trackId: '00000000-0000-0000-0000-000000000000',
        expectedRevision: revision,
      },
    });
    expect(res.statusCode).toBe(404);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(owner),
    });
    expect(detail.json().revision).toBe(revision);
    expect(detail.json().items).toHaveLength(0);
    const changes = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/changes`,
      headers: auth(owner),
    });
    expect(changes.json().some((c: { action: string }) => c.action === 'TRACK_ADDED')).toBe(false);
  });

  it('soft-deleted track cannot be added to a collaborative playlist', async () => {
    const doomed = await prisma.track.create({
      data: { title: 'Phase27 Doomed Track', artistId, durationMs: 60_000 },
    });
    await prisma.track.update({ where: { id: doomed.id }, data: { deletedAt: new Date() } });

    const playlistId = await createPlaylist(owner, 'Phase27 Rev Eight');
    const revision = await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(owner),
      payload: { trackId: doomed.id, expectedRevision: revision },
    });
    expect(res.statusCode).toBe(404);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(owner),
    });
    expect(detail.json().revision).toBe(revision);
  });
});
// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

describe('playlist invitations', () => {
  it('owner creates an invitation; the raw token is returned exactly once', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite One');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/invitations`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.invitation.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.invitation.usedAt).toBeNull();
    expect(body.invitation.revokedAt).toBeNull();
    expect(new Date(body.invitation.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('stores only a SHA-256 hash of the token, never plaintext', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Two');
    await enableCollaboration(owner, playlistId);
    const { token, invitationId } = await createInvitationRaw(owner, playlistId);
    const row = await prisma.playlistInvitation.findUnique({ where: { id: invitationId } });
    expect(row).not.toBeNull();
    const expected = createHash('sha256').update(token, 'utf8').digest('hex');
    expect(row!.tokenHash).toBe(expected);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.tokenHash).not.toContain(token);
    expect(token).not.toContain(row!.tokenHash);
  });

  it('editor cannot create invitations (404)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Three');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/invitations`,
      headers: auth(editor),
    });
    expect(res.statusCode).toBe(404);
  });

  it('invitation list never exposes token material', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Four');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/invitations`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBeGreaterThan(0);
    for (const inv of body) {
      expect(inv).not.toHaveProperty('token');
      expect(inv).not.toHaveProperty('tokenHash');
      expect(JSON.stringify(inv)).not.toContain(token);
    }
  });

  it('accepting an invitation makes the caller an editor (server-derived)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Five');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(playlistId);
    expect(res.json().viewerRole).toBe('EDITOR');

    const members = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/members`,
      headers: auth(owner),
    });
    expect(members.statusCode).toBe(200);
    const entry = members.json().find((m: { userId: string }) => m.userId === editor.id) as {
      role: string;
    };
    expect(entry.role).toBe('EDITOR');
  });

  it('reused invitation tokens are rejected', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Six');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    const first = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(stranger),
      payload: { token },
    });
    expect(second.statusCode).toBe(409);
    expectProblemJson(second);
  });

  it('revoked invitation tokens are rejected', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Seven');
    await enableCollaboration(owner, playlistId);
    const { token, invitationId } = await createInvitationRaw(owner, playlistId);
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/invitations/${invitationId}`,
      headers: auth(owner),
    });
    expect(revoke.statusCode).toBe(204);
    const accept = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    expect(accept.statusCode).toBe(403);
    expectProblemJson(accept);
  });

  it('expired invitation tokens are rejected', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Eight');
    await enableCollaboration(owner, playlistId);
    const { token, invitationId } = await createInvitationRaw(owner, playlistId);
    await prisma.playlistInvitation.update({
      where: { id: invitationId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const accept = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    expect(accept.statusCode).toBe(403);
    expectProblemJson(accept);
  });

  it('unknown invitation tokens are 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token: 'definitely-not-a-real-invitation-token' },
    });
    expect(res.statusCode).toBe(404);
    expectProblemJson(res);
  });

  it('invitations cannot be created on non-collaborative playlists (400)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Nine');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/invitations`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

describe('playlist members', () => {
  it('owner lists members including themselves as OWNER', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Members One');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/members`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ownerEntry = body.find((m: { userId: string }) => m.userId === owner.id);
    const editorEntry = body.find((m: { userId: string }) => m.userId === editor.id);
    expect(ownerEntry.role).toBe('OWNER');
    expect(editorEntry.role).toBe('EDITOR');
    expect(body[0]).not.toHaveProperty('email');
  });

  it('non-member cannot list members (404)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Members Two');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/members`,
      headers: auth(stranger),
    });
    expect(res.statusCode).toBe(404);
  });

  it('editor can leave; afterwards a private playlist is 404 for them', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Members Three');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const leave = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/members/me`,
      headers: auth(editor),
    });
    expect(leave.statusCode).toBe(204);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(editor),
    });
    expect(detail.statusCode).toBe(404);
  });

  it('owner cannot leave (400)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Members Four');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/members/me`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(400);
    expectProblemJson(res);
  });

  it('owner can remove a member; the member loses access immediately', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Members Five');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });

    const remove = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/members/${editor.id}`,
      headers: auth(owner),
    });
    expect(remove.statusCode).toBe(204);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(editor),
    });
    expect(detail.statusCode).toBe(404);

    // The removed member's write is denied too.
    const detail2 = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(owner),
    });
    const revision = detail2.json().revision as number;
    const write = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(editor),
      payload: { trackId: trackIds[0], expectedRevision: revision },
    });
    expect(write.statusCode).toBe(404);
  });

  it('owner cannot remove themselves (400)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Members Six');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/members/${owner.id}`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(400);
    expectProblemJson(res);
  });

  it('editor cannot remove another member (404)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Members Seven');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/members/${editor.id}`,
      headers: auth(editor),
    });
    expect(res.statusCode).toBe(404);
  });

  it('removing a non-member is 404', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Members Eight');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/members/${stranger.id}`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Change history
// ---------------------------------------------------------------------------

describe('GET /v1/playlists/:id/changes', () => {
  it('records an append-only audit trail of collaboration events', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Changes One');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const beforeAdd = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(owner),
    });
    const currentRevision = beforeAdd.json().revision as number;
    const add = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(editor),
      payload: { trackId: trackIds[0], expectedRevision: currentRevision },
    });
    expect(add.statusCode).toBe(201);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/changes`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const actions = body.map((c: { action: string }) => c.action);
    for (const expected of [
      'COLLAB_ENABLED',
      'INVITATION_CREATED',
      'INVITATION_ACCEPTED',
      'MEMBER_ADDED',
      'TRACK_ADDED',
    ]) {
      expect(actions).toContain(expected);
    }
    const added = body.find((c: { action: string }) => c.action === 'TRACK_ADDED');
    expect(added.actorUserId).toBe(editor.id);
    expect(added.actorDisplayName).toBeTruthy();
    expect(added.trackId).toBe(trackIds[0]);
    expect(typeof added.revision).toBe('number');
    // Revisions are non-decreasing over the history.
    const revisions = body.map((c: { revision: number }) => c.revision);
    const sorted = [...revisions].sort((a, b) => a - b);
    expect(revisions).toEqual(sorted.reverse());
  });

  it('editors can read change history; non-members get 404', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Changes Two');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });

    const asEditor = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/changes`,
      headers: auth(editor),
    });
    expect(asEditor.statusCode).toBe(200);

    const asStranger = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/changes`,
      headers: auth(stranger),
    });
    expect(asStranger.statusCode).toBe(404);
  });

  it('playlist_changes is append-only: raw UPDATE and DELETE fail', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Changes Three');
    await enableCollaboration(owner, playlistId);
    const row = await prisma.playlistChange.findFirst({ where: { playlistId } });
    expect(row).not.toBeNull();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "playlist_changes" SET "revision" = 999999 WHERE "id" = '${row!.id}'::uuid`,
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "playlist_changes" WHERE "id" = '${row!.id}'::uuid`),
    ).rejects.toThrow(/append-only/i);
    // The row is untouched.
    const after = await prisma.playlistChange.findUnique({ where: { id: row!.id } });
    expect(after).not.toBeNull();
    expect(after!.revision).toBe(row!.revision);
  });
});
// ---------------------------------------------------------------------------
// Privacy, visibility, and discovery isolation
// ---------------------------------------------------------------------------

describe('collaboration privacy boundaries', () => {
  it('private collaborative playlist is invisible to strangers (detail 404)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Private One');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(stranger),
    });
    expect(res.statusCode).toBe(404);
  });

  it('private collaborative playlist never appears in public listings', async () => {
    const title = `Phase27 Hidden Mix ${Date.now()}`;
    const playlistId = await createPlaylist(owner, title);
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playlists/public?q=${encodeURIComponent(title)}`,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain(playlistId);
  });

  it('private collaborative playlist does not leak into discovery recommendations', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Private Recs');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/discovery/recommendations?limit=25',
      headers: auth(stranger),
    });
    // The endpoint may be unavailable without AI configuration; the point is
    // it must never surface the private playlist.
    if (res.statusCode === 200) {
      expect(JSON.stringify(res.json())).not.toContain(playlistId);
    } else {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
  });

  it('public collaborative playlist: stranger reads with viewerRole null but cannot write', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Public One', 'PUBLIC');
    const revision = await enableCollaboration(owner, playlistId);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(stranger),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().viewerRole).toBeNull();

    const write = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(stranger),
      payload: { trackId: trackIds[0], expectedRevision: revision },
    });
    expect(write.statusCode).toBe(404);
  });

  it('unauthenticated reader sees a public collaborative playlist with viewerRole null', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Public Two', 'PUBLIC');
    await enableCollaboration(owner, playlistId);
    const detail = await app.inject({ method: 'GET', url: `/v1/playlists/${playlistId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().viewerRole).toBeNull();
    expect(detail.json().isCollaborative).toBe(true);
  });

  it('GET /v1/me/playlists includes playlists the user is a member of', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Mine One');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/playlists',
      headers: auth(editor),
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(playlistId);
  });

  it('viewerRole is OWNER for the owner and EDITOR for the editor', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Roles One');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const asOwner = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(owner),
    });
    expect(asOwner.json().viewerRole).toBe('OWNER');
    const asEditor = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(editor),
    });
    expect(asEditor.json().viewerRole).toBe('EDITOR');
  });

  it('collaboration creates no playback entitlement for members', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Entitlement One');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    // Membership grants playlist access only — no playback sessions or
    // royalty records are minted as a side effect of collaboration.
    const sessions = await prisma.playbackSession.count({ where: { userId: editor.id } });
    const earnings = await prisma.royaltyEarning.count({
      where: { artist: { ownerUserId: editor.id } },
    });
    expect(sessions).toBe(0);
    expect(earnings).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Disabling collaboration
// ---------------------------------------------------------------------------

describe('disabling collaboration', () => {
  it('removes members and revokes invitations immediately', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Disable One');
    await enableCollaboration(owner, playlistId);
    const { token: usedToken } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token: usedToken },
    });
    const { token: pendingToken, invitationId } = await createInvitationRaw(owner, playlistId);

    const disable = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/collaboration`,
      headers: auth(owner),
      payload: { isCollaborative: false },
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json().isCollaborative).toBe(false);

    // The former editor loses access immediately.
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(editor),
    });
    expect(detail.statusCode).toBe(404);

    // The pending invitation was revoked: acceptance is rejected.
    const accept = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(stranger),
      payload: { token: pendingToken },
    });
    expect([403, 404, 409]).toContain(accept.statusCode);

    const members = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/members`,
      headers: auth(owner),
    });
    expect(members.json()).toHaveLength(1); // only the owner remains

    const invitations = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/invitations`,
      headers: auth(owner),
    });
    const pending = invitations.json().find((i: { id: string }) => i.id === invitationId) as {
      revokedAt: string | null;
    };
    expect(pending.revokedAt).not.toBeNull();
  });

  it('editor cannot disable collaboration (404)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Disable Two');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/collaboration`,
      headers: auth(editor),
      payload: { isCollaborative: false },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Spoof prevention — no client-supplied actor/owner/member ids are honored
// ---------------------------------------------------------------------------

describe('spoof prevention', () => {
  it('ignores client-supplied actor/owner ids on track mutation bodies', async () => {
    // Fastify's validator strips unknown properties (removeAdditional), so
    // spoofed ids never reach the handlers: the adds succeed and every
    // history row credits the session user, not the spoofed id.
    const playlistId = await createPlaylist(owner, 'Phase27 Spoof One');
    const revision = await enableCollaboration(owner, playlistId);
    const bodies = [
      { trackId: trackIds[0], expectedRevision: revision, actorUserId: stranger.id },
      { trackId: trackIds[1], expectedRevision: revision + 1, ownerUserId: stranger.id },
      { trackId: trackIds[2], expectedRevision: revision + 2, addedByUserId: stranger.id },
    ];
    for (const payload of bodies) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${playlistId}/tracks`,
        headers: auth(owner),
        payload,
      });
      expect(res.statusCode).toBe(201);
    }
    const changes = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/changes`,
      headers: auth(owner),
    });
    const added = changes.json().filter((c: { action: string }) => c.action === 'TRACK_ADDED');
    expect(added).toHaveLength(3);
    for (const entry of added) {
      expect(entry.actorUserId).toBe(owner.id);
    }
  });

  it('ignores client-supplied user ids on invitation accept and settings', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Spoof Two');
    await enableCollaboration(owner, playlistId);
    // Unknown token still 404 — the stripped userId cannot conjure access.
    const accept = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token: 'x', userId: owner.id },
    });
    expect(accept.statusCode).toBe(404);

    // The stripped userId cannot change ownership either.
    const settings = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/collaboration`,
      headers: auth(owner),
      payload: { isCollaborative: true, userId: stranger.id },
    });
    expect(settings.statusCode).toBe(200);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(owner),
    });
    expect(detail.json().ownerUserId).toBe(owner.id);
  });
});

// ---------------------------------------------------------------------------
// Membership: list, leave, remove
// ---------------------------------------------------------------------------

describe('playlist membership', () => {
  it('owner and editor can list members; entries carry role + joinedAt', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Members One');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    const accept = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().viewerRole).toBe('EDITOR');

    for (const viewer of [owner, editor]) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/playlists/${playlistId}/members`,
        headers: auth(viewer),
      });
      expect(res.statusCode).toBe(200);
      const members = res.json();
      expect(members).toHaveLength(2);
      const ownerEntry = members.find((m: { userId: string }) => m.userId === owner.id);
      const editorEntry = members.find((m: { userId: string }) => m.userId === editor.id);
      expect(ownerEntry.role).toBe('OWNER');
      expect(editorEntry.role).toBe('EDITOR');
      expect(typeof editorEntry.joinedAt).toBe('string');
      expect(typeof editorEntry.displayName).toBe('string');
    }
  });

  it('non-member cannot list members of a private playlist (404)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Members Two');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/members`,
      headers: auth(stranger),
    });
    expect(res.statusCode).toBe(404);
    expectProblemJson(res);
  });

  it('editor can leave; afterwards they lose read and write access immediately', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Members Three');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });

    const leave = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/members/me`,
      headers: auth(editor),
    });
    expect(leave.statusCode).toBe(204);

    const read = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(editor),
    });
    expect(read.statusCode).toBe(404);

    const members = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/members`,
      headers: auth(editor),
    });
    expect(members.statusCode).toBe(404);
  });

  it('owner cannot leave their own playlist (400)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Members Four');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/members/me`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(400);
    expectProblemJson(res);
  });

  it('owner can remove an editor; the editor loses access immediately', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Members Five');
    const revision = await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });

    const remove = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/members/${editor.id}`,
      headers: auth(owner),
    });
    expect(remove.statusCode).toBe(204);

    const read = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(editor),
    });
    expect(read.statusCode).toBe(404);

    const write = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(editor),
      payload: { trackId: trackIds[0], expectedRevision: revision },
    });
    expect(write.statusCode).toBe(404);
  });

  it('editor cannot remove members (404 — owner-only)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Members Seven');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/members/${editor.id}`,
      headers: auth(editor),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Invitations: lifecycle + token security
// ---------------------------------------------------------------------------

describe('playlist invitations', () => {
  it('create returns the raw token exactly once with invitation metadata', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite One');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/invitations`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.invitation.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.invitation.usedAt).toBeNull();
    expect(body.invitation.revokedAt).toBeNull();
    expect(typeof body.invitation.expiresAt).toBe('string');
    expect(body.invitation.createdByUserId).toBe(owner.id);
  });

  it('only the SHA-256 hash of the token is stored — never plaintext', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Two');
    await enableCollaboration(owner, playlistId);
    const { token, invitationId } = await createInvitationRaw(owner, playlistId);
    const row = await prisma.playlistInvitation.findUnique({ where: { id: invitationId } });
    expect(row).not.toBeNull();
    const expectedHash = createHash('sha256').update(token, 'utf8').digest('hex');
    expect(row!.tokenHash).toBe(expectedHash);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.tokenHash).not.toContain(token);
  });

  it('token material never appears outside the 201 create response', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Three');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/invitations`,
      headers: auth(owner),
    });
    expect(list.statusCode).toBe(200);
    for (const item of list.json()) {
      expect(item).not.toHaveProperty('token');
      expect(item).not.toHaveProperty('tokenHash');
    }

    const accept = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json()).not.toHaveProperty('token');

    const changes = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/changes`,
      headers: auth(owner),
    });
    expect(JSON.stringify(changes.json())).not.toContain(token);
  });

  it('invitation cannot be created on a non-collaborative playlist (400)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Four');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/invitations`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(400);
    expectProblemJson(res);
  });

  it('editor cannot create invitations (404 — owner-only)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Five');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/invitations`,
      headers: auth(editor),
    });
    expect(res.statusCode).toBe(404);
  });

  it('accept grants EDITOR to the signed-in user — never a client-supplied id', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Six');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);

    // A client-supplied userId is stripped by validation; the session user
    // becomes the member, not the spoofed id.
    const accept = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(stranger),
      payload: { token, userId: owner.id },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().viewerRole).toBe('EDITOR');

    const members = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/members`,
      headers: auth(owner),
    });
    const ids = members.json().map((m: { userId: string }) => m.userId);
    expect(ids).toContain(stranger.id);
    expect(ids).not.toContain(editor.id);
  });

  it('reused invitation is rejected (409) and stays single-use', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Seven');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    const first = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(stranger),
      payload: { token },
    });
    expect(second.statusCode).toBe(409);
    expectProblemJson(second);

    const members = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/members`,
      headers: auth(owner),
    });
    expect(members.json()).toHaveLength(2); // owner + editor only
  });

  it('revoked invitation is rejected (403); revoking is idempotent', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Eight');
    await enableCollaboration(owner, playlistId);
    const { token, invitationId } = await createInvitationRaw(owner, playlistId);

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/invitations/${invitationId}`,
      headers: auth(owner),
    });
    expect(revoke.statusCode).toBe(204);
    const revokeAgain = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/invitations/${invitationId}`,
      headers: auth(owner),
    });
    expect(revokeAgain.statusCode).toBe(204);

    const accept = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    expect(accept.statusCode).toBe(403);
    expectProblemJson(accept);
  });

  it('already-used invitation cannot be revoked (409)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Nine');
    await enableCollaboration(owner, playlistId);
    const { token, invitationId } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/invitations/${invitationId}`,
      headers: auth(owner),
    });
    expect(revoke.statusCode).toBe(409);
  });

  it('expired invitation is rejected (403)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Ten');
    await enableCollaboration(owner, playlistId);
    const { token, invitationId } = await createInvitationRaw(owner, playlistId);
    await prisma.playlistInvitation.update({
      where: { id: invitationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const accept = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    expect(accept.statusCode).toBe(403);
    expectProblemJson(accept);
  });

  it('unknown invitation token is 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token: 'definitely-not-a-real-token' },
    });
    expect(res.statusCode).toBe(404);
    expectProblemJson(res);
  });

  it('owner cannot accept their own invitation (400)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Eleven');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(owner),
      payload: { token },
    });
    expect(res.statusCode).toBe(400);
  });

  it('editor cannot list or revoke invitations (404 — owner-only)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Invite Twelve');
    await enableCollaboration(owner, playlistId);
    const { token, invitationId } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const list = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/invitations`,
      headers: auth(editor),
    });
    expect(list.statusCode).toBe(404);
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}/invitations/${invitationId}`,
      headers: auth(editor),
    });
    expect(revoke.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Change history
// ---------------------------------------------------------------------------

describe('GET /v1/playlists/:id/changes', () => {
  it('records collaboration lifecycle events with actor, action, and revision', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Changes One');
    const rev0 = await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const add = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(editor),
      payload: { trackId: trackIds[0], expectedRevision: rev0 + 2 },
    });
    expect(add.statusCode).toBe(201);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/changes`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(200);
    const changes = res.json();
    const actions = changes.map((c: { action: string }) => c.action);
    for (const expected of [
      'COLLAB_ENABLED',
      'INVITATION_CREATED',
      'INVITATION_ACCEPTED',
      'MEMBER_ADDED',
      'TRACK_ADDED',
    ]) {
      expect(actions).toContain(expected);
    }
    // Newest first.
    const revisions = changes.map((c: { revision: number }) => c.revision);
    expect([...revisions].sort((a, b) => b - a)).toEqual(revisions);

    const trackAdded = changes.find((c: { action: string }) => c.action === 'TRACK_ADDED');
    expect(trackAdded.actorUserId).toBe(editor.id);
    expect(trackAdded.actorDisplayName).toBe('editor User');
    expect(trackAdded.trackId).toBe(trackIds[0]);
    expect(typeof trackAdded.itemId).toBe('string');
    expect(typeof trackAdded.createdAt).toBe('string');
  });

  it('supports the limit parameter', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Changes Two');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/changes?limit=1`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it('non-member cannot read change history (404)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Changes Three');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/changes`,
      headers: auth(stranger),
    });
    expect(res.statusCode).toBe(404);
  });

  it('change history is append-only: UPDATE and DELETE are rejected by the DB trigger', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Changes Four');
    await enableCollaboration(owner, playlistId);
    const row = await prisma.playlistChange.findFirst({ where: { playlistId } });
    expect(row).not.toBeNull();

    await expect(
      prisma.playlistChange.update({ where: { id: row!.id }, data: { revision: 9999 } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM playlist_changes WHERE id = '${row!.id}'`),
    ).rejects.toThrow(/append-only/);

    const fresh = await prisma.playlistChange.findUnique({ where: { id: row!.id } });
    expect(fresh!.revision).toBe(row!.revision);
  });
});

// ---------------------------------------------------------------------------
// Privacy, roles, and visibility
// ---------------------------------------------------------------------------

describe('collaboration privacy and roles', () => {
  it('private collaborative playlists never surface in the public listing for non-members', async () => {
    const uniqueTitle = `Phase27 Secret ${Date.now()}-${counter++}`;
    const playlistId = await createPlaylist(owner, uniqueTitle, 'PRIVATE');
    await enableCollaboration(owner, playlistId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/playlists/public?q=${encodeURIComponent(uniqueTitle)}`,
      headers: auth(stranger),
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(playlistId);
  });

  it('cross-user isolation: stranger gets 404 on a private collaborative playlist', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Privacy Two');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(stranger),
    });
    expect(res.statusCode).toBe(404);
  });

  it('public collaborative playlist is readable by strangers (viewerRole null) but not writable', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Privacy Three', 'PUBLIC');
    const revision = await enableCollaboration(owner, playlistId);

    const read = await app.inject({ method: 'GET', url: `/v1/playlists/${playlistId}` });
    expect(read.statusCode).toBe(200);
    expect(read.json().viewerRole).toBe(null);
    expect(read.json().isCollaborative).toBe(true);

    const write = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(stranger),
      payload: { trackId: trackIds[0], expectedRevision: revision },
    });
    expect(write.statusCode).toBe(404);
  });

  it('unlisted collaborative playlist is readable by any signed-in user with viewerRole null', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Privacy Four', 'UNLISTED');
    await enableCollaboration(owner, playlistId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(stranger),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().viewerRole).toBe(null);
  });

  it('my playlists include collaborative memberships, not just owned playlists', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Privacy Five', 'PRIVATE');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/playlists',
      headers: auth(editor),
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((p: { id: string }) => p.id);
    expect(ids).toContain(playlistId);
    expect(res.json().data.find((p: { id: string }) => p.id === playlistId).isCollaborative).toBe(
      true,
    );
  });

  it('disabling collaboration removes members and revokes invitations immediately', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Disable One');
    await enableCollaboration(owner, playlistId);
    const first = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token: first.token },
    });
    const pending = await createInvitationRaw(owner, playlistId);

    const disable = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/collaboration`,
      headers: auth(owner),
      payload: { isCollaborative: false },
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json().isCollaborative).toBe(false);

    // Former editor loses read access immediately.
    const read = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(editor),
    });
    expect(read.statusCode).toBe(404);

    // Members list shows only the owner again.
    const members = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}/members`,
      headers: auth(owner),
    });
    expect(members.statusCode).toBe(200);
    expect(members.json()).toHaveLength(1);
    expect(members.json()[0].role).toBe('OWNER');

    // The pending invitation was revoked.
    const accept = await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(stranger),
      payload: { token: pending.token },
    });
    expect(accept.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Entitlement neutrality + spoof prevention
// ---------------------------------------------------------------------------

describe('entitlement and spoof prevention', () => {
  it('collaboration grants no playback entitlement (403 Subscription Required)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Entitlement One');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });

    // The fixture tracks are PROCESSING; mark one READY so the availability
    // gate passes and the request reaches the entitlement check. Neither the
    // owner nor the editor holds a subscription, so both are denied.
    await prisma.track.update({ where: { id: trackIds[0] }, data: { status: 'READY' } });
    try {
      for (const user of [editor, owner]) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/playback/sessions',
          headers: auth(user),
          payload: { trackId: trackIds[0] },
        });
        expect(res.statusCode).toBe(403);
        expectProblemJson(res);
        expect(res.json().title).toBe('Subscription Required');
      }
    } finally {
      await prisma.track.update({ where: { id: trackIds[0] }, data: { status: 'PROCESSING' } });
    }
  });

  it('client-supplied ids in mutation bodies are stripped, never trusted', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Spoof One');
    const revision = await enableCollaboration(owner, playlistId);

    const add = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(owner),
      payload: { trackId: trackIds[0], expectedRevision: revision, actorUserId: stranger.id },
    });
    expect(add.statusCode).toBe(201);
    const rev1 = Number(add.headers['x-playlist-revision']);

    const settings = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/collaboration`,
      headers: auth(owner),
      payload: { isCollaborative: true, ownerUserId: stranger.id },
    });
    expect(settings.statusCode).toBe(200);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(owner),
    });
    expect(detail.json().ownerUserId).toBe(owner.id);

    const move = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}/tracks/${add.json().id}`,
      headers: auth(owner),
      payload: { position: 9, expectedRevision: rev1, addedByUserId: stranger.id },
    });
    expect(move.statusCode).toBe(200);
    expect(move.json().position).toBe(9);
  });

  it('owner-only playlist metadata updates still reject editors (404)', async () => {
    const playlistId = await createPlaylist(owner, 'Phase27 Spoof Two');
    await enableCollaboration(owner, playlistId);
    const { token } = await createInvitationRaw(owner, playlistId);
    await app.inject({
      method: 'POST',
      url: '/v1/playlists/invitations/accept',
      headers: auth(editor),
      payload: { token },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(editor),
      payload: { title: 'Hijacked Title' },
    });
    expect(res.statusCode).toBe(404);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(owner),
    });
    expect(detail.json().title).toBe('Phase27 Spoof Two');
  });
});
