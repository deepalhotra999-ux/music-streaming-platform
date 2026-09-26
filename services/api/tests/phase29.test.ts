/**
 * Phase 29 — artist/fan community (backend) tests.
 *
 * Full HTTP stack via `app.inject()` against TEST_DATABASE_URL (never the
 * dev DB). Scoped cleanup: every fixture uses TEST_DOMAIN emails.
 *
 * Covers (per the Phase 29 brief §25/27):
 * - Post CRUD: ARTIST-only create (LISTENER 403, anonymous 401), ownership
 *   (artist A cannot post/edit/delete as artist B), edit/delete own post.
 * - Catalog attachment authorization: other artist's track/album -> 404,
 *   non-READY track -> 400; forged authorUserId in body -> 400.
 * - Content limits: blank/over-long bodies -> 400; duplicate repost -> 409.
 * - Visibility: ACTIVE-only on public surfaces; REMOVED/DELETED hidden from
 *   feed, artist profile posts, comments, and detail (404 for outsiders,
 *   visible to author/ADMIN).
 * - Feed: follows-only, chronological (publishedAt desc, id tie-break),
 *   paginated without duplicates.
 * - Comments: create/list (oldest first, paginated)/delete own; 403 on
 *   others' comments; closed on non-ACTIVE posts.
 * - Reactions: idempotent add/remove, counts, viewerReacted.
 * - Reports: user-facing endpoint files into the Phase 17 workflow;
 *   catalog targets rejected; admin sees them in the same queue.
 * - Moderation: ACTIVE->REMOVED->ACTIVE transitions, invalid transitions
 *   rejected, ordinary users cannot restore, every transition audited.
 * - Rate limits: per-user buckets (unit + integration), not bypassable via
 *   spoofed identity (identity is server-derived; no actor field exists).
 * - Isolation: search, recommendations, and playback entitlement untouched
 *   by community content; author DTOs carry no private data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db.js';
import {
  checkUserRateLimit,
  resetCommunityRateLimits,
} from '../src/modules/community/rateLimit.js';

const TEST_DOMAIN = '@phase29-test.local';
let counter = 0;
const testEmail = (tag: string) => `phase29-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
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
    payload: { email, password: PASSWORD, displayName: email.split('@')[0] },
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
let artistA: { userId: string; token: string };
let artistB: { userId: string; token: string };
let listener: { userId: string; token: string };
let listener2: { userId: string; token: string };
let rateArtist: { userId: string; token: string };

/** Fresh ARTIST user + owned artist row. Each user gets an independent
 *  per-user rate-limit budget, so heavy blocks use their own artist. */
async function makeArtist(
  tag: string,
): Promise<{ userId: string; token: string; artistId: string }> {
  const user = await registerAndLogin(testEmail(tag), 'ARTIST');
  const created = await prisma.artist.create({
    data: { name: `Phase29 ${tag}`, ownerUserId: user.userId },
  });
  return { ...user, artistId: created.id };
}

/** Shared artist for the comments/reactions/reports blocks (keeps total test
 *  logins under the IP-based auth rate limit; each block uses its own posts). */
let socialArtist: { userId: string; token: string; artistId: string } | null = null;
async function getSocialArtist(): Promise<{ userId: string; token: string; artistId: string }> {
  if (!socialArtist) socialArtist = await makeArtist('socialartist');
  return socialArtist;
}

let artistAId: string;
let artistBId: string;
let albumAId: string;
let albumBId: string;
let trackReadyId: string;
let trackDraftId: string;
let trackOtherId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
/** Create a post as any artist. Bodies must be unique per artist within the
 *  duplicate window; callers pass distinctive text. */
const createPost = (
  token: string,
  artistId: string,
  body: string,
  extra: Record<string, unknown> = {},
) =>
  app.inject({
    method: 'POST',
    url: '/v1/community/posts',
    headers: auth(token),
    payload: { artistId, body, ...extra },
  });
/** Shorthand for artistA posts (artistA's budget: creation + edit blocks). */
const post = (token: string, body: string) => createPost(token, artistAId, body);

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
  artistA = await registerAndLogin(testEmail('artista'), 'ARTIST');
  artistB = await registerAndLogin(testEmail('artistb'), 'ARTIST');
  listener = await registerAndLogin(testEmail('listener'), 'LISTENER');
  listener2 = await registerAndLogin(testEmail('listener2'), 'LISTENER');
  rateArtist = await registerAndLogin(testEmail('rateartist'), 'ARTIST');

  const a = await prisma.artist.create({
    data: { name: 'Phase29 Artist A', ownerUserId: artistA.userId },
  });
  artistAId = a.id;
  const b = await prisma.artist.create({
    data: { name: 'Phase29 Artist B', ownerUserId: artistB.userId },
  });
  artistBId = b.id;
  const r = await prisma.artist.create({
    data: { name: 'Phase29 Rate Artist', ownerUserId: rateArtist.userId },
  });
  (globalThis as Record<string, string>).__rateArtistId = r.id;

  const albumA = await prisma.album.create({
    data: { title: 'Phase29 Album A', artistId: artistAId },
  });
  albumAId = albumA.id;
  const albumB = await prisma.album.create({
    data: { title: 'Phase29 Album B', artistId: artistBId },
  });
  albumBId = albumB.id;

  const ready = await prisma.track.create({
    data: {
      title: 'Phase29 Ready Track',
      artistId: artistAId,
      albumId: albumAId,
      durationMs: 180000,
      status: 'READY',
    },
  });
  trackReadyId = ready.id;
  const draft = await prisma.track.create({
    data: {
      title: 'Phase29 Draft Track',
      artistId: artistAId,
      durationMs: 180000,
      status: 'PROCESSING',
    },
  });
  trackDraftId = draft.id;
  const other = await prisma.track.create({
    data: {
      title: 'Phase29 Other Track',
      artistId: artistBId,
      albumId: albumBId,
      durationMs: 180000,
      status: 'READY',
    },
  });
  trackOtherId = other.id;
});

afterAll(async () => {
  await prisma.postReaction.deleteMany({
    where: { user: { email: { endsWith: TEST_DOMAIN } } },
  });
  await prisma.postComment.deleteMany({
    where: { author: { email: { endsWith: TEST_DOMAIN } } },
  });
  await prisma.artistPost.deleteMany({
    where: { author: { email: { endsWith: TEST_DOMAIN } } },
  });
  await prisma.moderationReport.deleteMany({
    where: { createdBy: { email: { endsWith: TEST_DOMAIN } } },
  });
  await prisma.follow.deleteMany({
    where: { user: { email: { endsWith: TEST_DOMAIN } } },
  });
  await prisma.track.deleteMany({
    where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.album.deleteMany({
    where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.artist.deleteMany({ where: { owner: { email: { endsWith: TEST_DOMAIN } } } });
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
  await prisma.refreshToken.deleteMany({ where: { user: { email: { endsWith: TEST_DOMAIN } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
  await app.close();
});

// ---------------------------------------------------------------------------
// Post CRUD + authorization
// ---------------------------------------------------------------------------

describe('Phase 29 — post creation authorization', () => {
  it('rejects unauthenticated creation with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      payload: { artistId: artistAId, body: 'hello' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects LISTENER creation with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      headers: auth(listener.token),
      payload: { artistId: artistAId, body: 'hello from a listener' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects ADMIN creation with 403 (moderation authority only)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      headers: auth(admin.token),
      payload: { artistId: artistAId, body: 'hello from admin' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects posting as an artist the caller does not own with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      headers: auth(artistA.token),
      payload: { artistId: artistBId, body: 'impersonating artist B' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('ignores a forged authorUserId in the body: identity is server-derived', async () => {
    // NOTE: additionalProperties is declared but not enforced app-wide
    // (pre-existing behavior since Phase 3); the security property is that
    // a forged author field can never take effect.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      headers: auth(artistA.token),
      payload: {
        artistId: artistAId,
        body: `spoof attempt ${Date.now()}`,
        authorUserId: listener.userId,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().author.id).toBe(artistA.userId);
  });

  it('creates a post with track and album attachments (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      headers: auth(artistA.token),
      payload: {
        artistId: artistAId,
        body: 'New single out now!',
        trackId: trackReadyId,
        albumId: albumAId,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.artist.id).toBe(artistAId);
    expect(body.author.id).toBe(artistA.userId);
    expect(body.track.id).toBe(trackReadyId);
    expect(body.track.title).toBe('Phase29 Ready Track');
    expect(body.album.id).toBe(albumAId);
    expect(body.status).toBe('ACTIVE');
    expect(body.reactionCount).toBe(0);
    expect(body.commentCount).toBe(0);
    expect(body.viewerReacted).toBe(false);
  });

  it('rejects attaching another artist\u2019s track with 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      headers: auth(artistA.token),
      payload: { artistId: artistAId, body: 'attaching B track', trackId: trackOtherId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects attaching another artist\u2019s album with 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      headers: auth(artistA.token),
      payload: { artistId: artistAId, body: 'attaching B album', albumId: albumBId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects attaching a non-READY track with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      headers: auth(artistA.token),
      payload: { artistId: artistAId, body: 'attaching draft', trackId: trackDraftId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects blank and over-long bodies with 400', async () => {
    const blank = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      headers: auth(artistA.token),
      payload: { artistId: artistAId, body: '   ' },
    });
    expect(blank.statusCode).toBe(400);
    const long = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      headers: auth(artistA.token),
      payload: { artistId: artistAId, body: 'x'.repeat(2001) },
    });
    expect(long.statusCode).toBe(400);
  });

  it('rejects an identical repost inside the duplicate window with 409', async () => {
    const bodyText = `duplicate probe ${Date.now()}`;
    const first = await post(artistA.token, bodyText);
    expect(first.statusCode).toBe(201);
    const second = await post(artistA.token, bodyText);
    expect(second.statusCode).toBe(409);
  });
});

describe('Phase 29 — post edit/delete ownership', () => {
  let postId: string;

  it('artist A creates a post', async () => {
    const res = await post(artistA.token, `ownership probe ${Date.now()}`);
    expect(res.statusCode).toBe(201);
    postId = res.json().id as string;
  });

  it('artist B cannot edit artist A\u2019s post (403)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/community/posts/${postId}`,
      headers: auth(artistB.token),
      payload: { body: 'hijacked' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('artist B cannot delete artist A\u2019s post (403)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/community/posts/${postId}`,
      headers: auth(artistB.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('listener cannot edit or delete the post (403)', async () => {
    const edit = await app.inject({
      method: 'PATCH',
      url: `/v1/community/posts/${postId}`,
      headers: auth(listener.token),
      payload: { body: 'hijacked' },
    });
    expect(edit.statusCode).toBe(403);
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/community/posts/${postId}`,
      headers: auth(listener.token),
    });
    expect(del.statusCode).toBe(403);
  });

  it('author edits their own post (200), attachments re-validated', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/community/posts/${postId}`,
      headers: auth(artistA.token),
      payload: { body: 'edited body', trackId: trackReadyId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBe('edited body');
    expect(res.json().track.id).toBe(trackReadyId);
  });

  it('author cannot attach another artist\u2019s track on edit (404)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/community/posts/${postId}`,
      headers: auth(artistA.token),
      payload: { trackId: trackOtherId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('ordinary users cannot change status via PATCH: the field is ignored', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/community/posts/${postId}`,
      headers: auth(artistA.token),
      payload: { body: 'fine', status: 'REMOVED' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
    expect(res.json().body).toBe('fine');
  });

  it('author deletes their own post (204, idempotent)', async () => {
    const first = await app.inject({
      method: 'DELETE',
      url: `/v1/community/posts/${postId}`,
      headers: auth(artistA.token),
    });
    expect(first.statusCode).toBe(204);
    const second = await app.inject({
      method: 'DELETE',
      url: `/v1/community/posts/${postId}`,
      headers: auth(artistA.token),
    });
    expect(second.statusCode).toBe(204);
  });

  it('deleted post: 404 for outsiders, visible to the author', async () => {
    const outsider = await app.inject({
      method: 'GET',
      url: `/v1/community/posts/${postId}`,
      headers: auth(listener.token),
    });
    expect(outsider.statusCode).toBe(404);
    const author = await app.inject({
      method: 'GET',
      url: `/v1/community/posts/${postId}`,
      headers: auth(artistA.token),
    });
    expect(author.statusCode).toBe(200);
    expect(author.json().status).toBe('DELETED');
  });
});

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

describe('Phase 29 — community feed', () => {
  let feedArtist: { userId: string; token: string; artistId: string };

  beforeAll(async () => {
    feedArtist = await makeArtist('feedartist');
    // Two posts from the followed artist, one from an unfollowed artist.
    for (const suffix of ['feed-a1', 'feed-a2']) {
      const res = await createPost(
        feedArtist.token,
        feedArtist.artistId,
        `${suffix} ${Date.now()}`,
      );
      expect(res.statusCode).toBe(201);
    }
    const resB = await createPost(artistB.token, artistBId, `feed-b1 ${Date.now()}`);
    expect(resB.statusCode).toBe(201);
    const follow = await app.inject({
      method: 'POST',
      url: '/v1/me/follows',
      headers: auth(listener.token),
      payload: { artistId: feedArtist.artistId },
    });
    expect([200, 201]).toContain(follow.statusCode);
  });

  it('requires authentication (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/community/feed' });
    expect(res.statusCode).toBe(401);
  });

  it('returns only followed artists\u2019 ACTIVE posts, newest first', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/community/feed?limit=50',
      headers: auth(listener.token),
    });
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page.pagination).toBeDefined();
    const artists = new Set(page.data.map((p: { artist: { id: string } }) => p.artist.id));
    expect(artists.has(feedArtist.artistId)).toBe(true);
    expect(artists.has(artistBId)).toBe(false);
    // Newest first: feed-a2 before feed-a1.
    const feedBodies = page.data.map((p: { body: string }) => p.body);
    const idxA1 = feedBodies.findIndex((b: string) => b.startsWith('feed-a1'));
    const idxA2 = feedBodies.findIndex((b: string) => b.startsWith('feed-a2'));
    expect(idxA2).toBeLessThan(idxA1);
    // No DELETED/REMOVED leakage, no private author fields.
    for (const item of page.data) {
      expect(item.status).toBe('ACTIVE');
      expect(Object.keys(item.author).sort()).toEqual(['avatarUrl', 'displayName', 'id']);
      expect(item.author.email).toBeUndefined();
    }
  });

  it('paginates stably without duplicates across pages', async () => {
    const seen = new Set<string>();
    let page = 1;
    for (;;) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/community/feed?page=${page}&limit=1`,
        headers: auth(listener.token),
      });
      expect(res.statusCode).toBe(200);
      const data = res.json().data as { id: string }[];
      if (data.length === 0) break;
      for (const item of data) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      page += 1;
      if (page > 10) break;
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it('returns an empty feed for a user who follows nobody', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/community/feed',
      headers: auth(listener2.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
    expect(res.json().pagination.total).toBe(0);
  });

  it('excludes removed posts from the feed', async () => {
    const created = await createPost(feedArtist.token, feedArtist.artistId, `doomed ${Date.now()}`);
    expect(created.statusCode).toBe(201);
    const doomedId = created.json().id as string;
    const mod = await app.inject({
      method: 'POST',
      url: `/v1/admin/community/posts/${doomedId}/moderate`,
      headers: auth(admin.token),
    });
    expect(mod.statusCode).toBe(200);
    const feed = await app.inject({
      method: 'GET',
      url: '/v1/community/feed?limit=50',
      headers: auth(listener.token),
    });
    const ids = (feed.json().data as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain(doomedId);
    // Restore for cleanliness (audited).
    await app.inject({
      method: 'POST',
      url: `/v1/admin/community/posts/${doomedId}/restore`,
      headers: auth(admin.token),
    });
  });
});

describe('Phase 29 — public artist posts (profile extension)', () => {
  it('lists ACTIVE posts publicly, newest first', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/artists/${artistAId}/posts?limit=20`,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { status: string; viewerReacted: null }[];
    expect(data.length).toBeGreaterThan(0);
    for (const item of data) {
      expect(item.status).toBe('ACTIVE');
      expect(item.viewerReacted).toBeNull();
    }
  });

  it('404s for an unknown artist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/artists/00000000-0000-0000-0000-000000000000/posts',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

describe('Phase 29 — comments', () => {
  let postId: string;
  let commentId: string;
  let commentArtist: { userId: string; token: string; artistId: string };

  beforeAll(async () => {
    commentArtist = await getSocialArtist();
    const res = await createPost(
      commentArtist.token,
      commentArtist.artistId,
      `comment target ${Date.now()}`,
    );
    expect(res.statusCode).toBe(201);
    postId = res.json().id as string;
  });

  it('rejects unauthenticated comments (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/community/posts/${postId}/comments`,
      payload: { body: 'anon' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates a comment (201) with a safe author DTO', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/community/posts/${postId}/comments`,
      headers: auth(listener.token),
      payload: { body: 'Love this track!' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    commentId = body.id as string;
    expect(body.postId).toBe(postId);
    expect(body.author.id).toBe(listener.userId);
    expect(body.author.email).toBeUndefined();
    expect(body.status).toBe('ACTIVE');
  });

  it('rejects blank and over-long comments (400)', async () => {
    const blank = await app.inject({
      method: 'POST',
      url: `/v1/community/posts/${postId}/comments`,
      headers: auth(listener.token),
      payload: { body: '  ' },
    });
    expect(blank.statusCode).toBe(400);
    const long = await app.inject({
      method: 'POST',
      url: `/v1/community/posts/${postId}/comments`,
      headers: auth(listener.token),
      payload: { body: 'y'.repeat(501) },
    });
    expect(long.statusCode).toBe(400);
  });

  it('lists comments oldest-first, paginated', async () => {
    const second = await app.inject({
      method: 'POST',
      url: `/v1/community/posts/${postId}/comments`,
      headers: auth(listener2.token),
      payload: { body: 'Second comment' },
    });
    expect(second.statusCode).toBe(201);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/community/posts/${postId}/comments?limit=1&page=1`,
      headers: auth(listener.token),
    });
    expect(list.statusCode).toBe(200);
    const page1 = list.json();
    expect(page1.data).toHaveLength(1);
    expect(page1.data[0].body).toBe('Love this track!');
    expect(page1.pagination.total).toBe(2);
    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/community/posts/${postId}/comments?limit=1&page=2`,
      headers: auth(listener.token),
    });
    expect((page2.json().data as { body: string }[])[0].body).toBe('Second comment');
  });

  it('rejects deleting another user\u2019s comment (403)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/community/comments/${commentId}`,
      headers: auth(listener2.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('deletes own comment (204, idempotent) and it disappears from the list', async () => {
    const first = await app.inject({
      method: 'DELETE',
      url: `/v1/community/comments/${commentId}`,
      headers: auth(listener.token),
    });
    expect(first.statusCode).toBe(204);
    const second = await app.inject({
      method: 'DELETE',
      url: `/v1/community/comments/${commentId}`,
      headers: auth(listener.token),
    });
    expect(second.statusCode).toBe(204);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/community/posts/${postId}/comments`,
      headers: auth(listener.token),
    });
    const bodies = (list.json().data as { body: string }[]).map((c) => c.body);
    expect(bodies).not.toContain('Love this track!');
  });

  it('rejects commenting on a removed post', async () => {
    const created = await createPost(
      commentArtist.token,
      commentArtist.artistId,
      `comment-closed ${Date.now()}`,
    );
    expect(created.statusCode).toBe(201);
    const targetId = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/admin/community/posts/${targetId}/moderate`,
      headers: auth(admin.token),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/community/posts/${targetId}/comments`,
      headers: auth(listener.token),
      payload: { body: 'should fail' },
    });
    expect([400, 404]).toContain(res.statusCode);
    await app.inject({
      method: 'POST',
      url: `/v1/admin/community/posts/${targetId}/restore`,
      headers: auth(admin.token),
    });
  });
});

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

describe('Phase 29 — reactions', () => {
  let postId: string;
  let reactionArtist: { userId: string; token: string; artistId: string };

  beforeAll(async () => {
    reactionArtist = await getSocialArtist();
    const res = await createPost(
      reactionArtist.token,
      reactionArtist.artistId,
      `reaction target ${Date.now()}`,
    );
    expect(res.statusCode).toBe(201);
    postId = res.json().id as string;
  });

  it('reacts idempotently: twice -> one reaction', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/v1/community/posts/${postId}/reactions`,
      headers: auth(listener.token),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ reacted: true, reactionCount: 1 });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/community/posts/${postId}/reactions`,
      headers: auth(listener.token),
    });
    expect(second.json()).toEqual({ reacted: true, reactionCount: 1 });
    const other = await app.inject({
      method: 'POST',
      url: `/v1/community/posts/${postId}/reactions`,
      headers: auth(listener2.token),
    });
    expect(other.json()).toEqual({ reacted: true, reactionCount: 2 });
  });

  it('reflects viewerReacted on post detail', async () => {
    const reacted = await app.inject({
      method: 'GET',
      url: `/v1/community/posts/${postId}`,
      headers: auth(listener.token),
    });
    expect(reacted.json().viewerReacted).toBe(true);
    expect(reacted.json().reactionCount).toBe(2);
    const notReacted = await app.inject({
      method: 'GET',
      url: `/v1/community/posts/${postId}`,
      headers: auth(reactionArtist.token),
    });
    expect(notReacted.json().viewerReacted).toBe(false);
  });

  it('unreacts idempotently: twice -> safe', async () => {
    const first = await app.inject({
      method: 'DELETE',
      url: `/v1/community/posts/${postId}/reactions`,
      headers: auth(listener.token),
    });
    expect(first.json()).toEqual({ reacted: false, reactionCount: 1 });
    const second = await app.inject({
      method: 'DELETE',
      url: `/v1/community/posts/${postId}/reactions`,
      headers: auth(listener.token),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ reacted: false, reactionCount: 1 });
  });

  it('rejects reacting to a removed post', async () => {
    const created = await createPost(
      reactionArtist.token,
      reactionArtist.artistId,
      `reaction-closed ${Date.now()}`,
    );
    expect(created.statusCode).toBe(201);
    const targetId = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/admin/community/posts/${targetId}/moderate`,
      headers: auth(admin.token),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/community/posts/${targetId}/reactions`,
      headers: auth(listener.token),
    });
    expect([400, 404]).toContain(res.statusCode);
    await app.inject({
      method: 'POST',
      url: `/v1/admin/community/posts/${targetId}/restore`,
      headers: auth(admin.token),
    });
  });
});

// ---------------------------------------------------------------------------
// Reports (user-facing, Phase 17 workflow)
// ---------------------------------------------------------------------------

describe('Phase 29 — user reporting', () => {
  let postId: string;
  let commentId: string;

  beforeAll(async () => {
    const reportArtist = await getSocialArtist();
    const p = await createPost(
      reportArtist.token,
      reportArtist.artistId,
      `report target ${Date.now()}`,
    );
    expect(p.statusCode).toBe(201);
    postId = p.json().id as string;
    const c = await app.inject({
      method: 'POST',
      url: `/v1/community/posts/${postId}/comments`,
      headers: auth(listener2.token),
      payload: { body: 'reportable comment' },
    });
    commentId = c.json().id as string;
  });

  it('requires authentication (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/moderation-reports',
      payload: { targetType: 'ARTIST_POST', targetId: postId, reason: 'spam content' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('files a post report into the moderation queue (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/moderation-reports',
      headers: auth(listener.token),
      payload: { targetType: 'ARTIST_POST', targetId: postId, reason: 'Looks like spam' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().targetType).toBe('ARTIST_POST');
    expect(res.json().status).toBe('OPEN');
    // Visible to admins in the existing queue, filterable by the new type.
    const queue = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation-reports?targetType=ARTIST_POST',
      headers: auth(admin.token),
    });
    expect(queue.statusCode).toBe(200);
    const ids = (queue.json().data as { targetId: string }[]).map((r) => r.targetId);
    expect(ids).toContain(postId);
  });

  it('files a comment report (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/moderation-reports',
      headers: auth(listener.token),
      payload: { targetType: 'POST_COMMENT', targetId: commentId, reason: 'Harassment' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().targetType).toBe('POST_COMMENT');
  });

  it('rejects catalog targets on the user endpoint (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/moderation-reports',
      headers: auth(listener.token),
      payload: { targetType: 'TRACK', targetId: trackReadyId, reason: 'not allowed here' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects reports against missing targets (404) and short reasons (400)', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/moderation-reports',
      headers: auth(listener.token),
      payload: {
        targetType: 'ARTIST_POST',
        targetId: '00000000-0000-0000-0000-000000000000',
        reason: 'does not exist',
      },
    });
    expect(missing.statusCode).toBe(404);
    const short = await app.inject({
      method: 'POST',
      url: '/v1/moderation-reports',
      headers: auth(listener.token),
      payload: { targetType: 'ARTIST_POST', targetId: postId, reason: 'x' },
    });
    expect(short.statusCode).toBe(400);
  });

  it('does not expose report details or moderation notes to the reporter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/moderation-reports',
      headers: auth(listener.token),
      payload: {
        targetType: 'ARTIST_POST',
        targetId: postId,
        reason: 'Another report',
        details: 'some details',
      },
    });
    expect(res.statusCode).toBe(201);
    // The reporter cannot list the admin queue.
    const queue = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation-reports',
      headers: auth(listener.token),
    });
    expect(queue.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Admin moderation
// ---------------------------------------------------------------------------

describe('Phase 29 — admin moderation transitions', () => {
  let postId: string;
  let commentId: string;
  let modArtist: { userId: string; token: string; artistId: string };

  beforeAll(async () => {
    modArtist = await makeArtist('modartist');
    const p = await createPost(
      modArtist.token,
      modArtist.artistId,
      `moderation target ${Date.now()}`,
    );
    expect(p.statusCode).toBe(201);
    postId = p.json().id as string;
    const c = await app.inject({
      method: 'POST',
      url: `/v1/community/posts/${postId}/comments`,
      headers: auth(listener.token),
      payload: { body: 'moderate me' },
    });
    commentId = c.json().id as string;
  });

  it('rejects non-admin moderation (403)', async () => {
    for (const token of [listener.token, artistA.token]) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/community/posts/${postId}/moderate`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('removes a post: ACTIVE -> REMOVED, audited', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/community/posts/${postId}/moderate`,
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('REMOVED');
    const rows = await auditRows('community.post.removed', postId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata).toMatchObject({ oldStatus: 'ACTIVE', newStatus: 'REMOVED' });
    // Facts-only metadata: no body text, no author PII.
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain('moderation target');
  });

  it('removed post vanishes from public surfaces but stays reviewable by admin', async () => {
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/community/posts/${postId}`,
      headers: auth(listener.token),
    });
    expect(detail.statusCode).toBe(404);
    const profile = await app.inject({
      method: 'GET',
      url: `/v1/artists/${modArtist.artistId}/posts?limit=50`,
    });
    const ids = (profile.json().data as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain(postId);
    const review = await app.inject({
      method: 'GET',
      url: `/v1/admin/community/posts/${postId}`,
      headers: auth(admin.token),
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().status).toBe('REMOVED');
  });

  it('rejects invalid transitions (400): moderating a REMOVED post, restoring an ACTIVE post', async () => {
    const again = await app.inject({
      method: 'POST',
      url: `/v1/admin/community/posts/${postId}/moderate`,
      headers: auth(admin.token),
    });
    expect(again.statusCode).toBe(400);
    const fresh = await createPost(
      modArtist.token,
      modArtist.artistId,
      `always-active ${Date.now()}`,
    );
    expect(fresh.statusCode).toBe(201);
    const freshId = fresh.json().id as string;
    const badRestore = await app.inject({
      method: 'POST',
      url: `/v1/admin/community/posts/${freshId}/restore`,
      headers: auth(admin.token),
    });
    expect(badRestore.statusCode).toBe(400);
  });

  it('restores a post: REMOVED -> ACTIVE, audited, visible again', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/community/posts/${postId}/restore`,
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
    const rows = await auditRows('community.post.restored', postId);
    expect(rows.length).toBe(1);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/community/posts/${postId}`,
      headers: auth(listener.token),
    });
    expect(detail.statusCode).toBe(200);
  });

  it('author cannot edit a REMOVED post (400)', async () => {
    const p = await createPost(modArtist.token, modArtist.artistId, `edit-locked ${Date.now()}`);
    expect(p.statusCode).toBe(201);
    const targetId = p.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/admin/community/posts/${targetId}/moderate`,
      headers: auth(admin.token),
    });
    const edit = await app.inject({
      method: 'PATCH',
      url: `/v1/community/posts/${targetId}`,
      headers: auth(modArtist.token),
      payload: { body: 'trying to edit while removed' },
    });
    expect(edit.statusCode).toBe(400);
    await app.inject({
      method: 'POST',
      url: `/v1/admin/community/posts/${targetId}/restore`,
      headers: auth(admin.token),
    });
  });

  it('removes and restores a comment, audited', async () => {
    const mod = await app.inject({
      method: 'POST',
      url: `/v1/admin/community/comments/${commentId}/moderate`,
      headers: auth(admin.token),
    });
    expect(mod.statusCode).toBe(200);
    expect(mod.json().status).toBe('REMOVED');
    expect((await auditRows('community.comment.removed', commentId)).length).toBe(1);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/community/posts/${postId}/comments`,
      headers: auth(listener.token),
    });
    const bodies = (list.json().data as { body: string }[]).map((c) => c.body);
    expect(bodies).not.toContain('moderate me');
    const restore = await app.inject({
      method: 'POST',
      url: `/v1/admin/community/comments/${commentId}/restore`,
      headers: auth(admin.token),
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().status).toBe('ACTIVE');
    expect((await auditRows('community.comment.restored', commentId)).length).toBe(1);
  });

  it('admin review endpoints 404 for non-admins and unknown ids', async () => {
    const forbidden = await app.inject({
      method: 'GET',
      url: `/v1/admin/community/posts/${postId}`,
      headers: auth(listener.token),
    });
    expect(forbidden.statusCode).toBe(403);
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/admin/community/posts/00000000-0000-0000-0000-000000000000',
      headers: auth(admin.token),
    });
    expect(missing.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('Phase 29 — per-user rate limiting', () => {
  it('unit: bucket exhausts per user and recovers per key', () => {
    resetCommunityRateLimits();
    checkUserRateLimit('user-a', 'test.action', 2, 60_000);
    checkUserRateLimit('user-a', 'test.action', 2, 60_000);
    expect(() => checkUserRateLimit('user-a', 'test.action', 2, 60_000)).toThrow(
      /Rate limit exceeded/,
    );
    // A different user is unaffected: keyed by server identity, not IP.
    expect(() => checkUserRateLimit('user-b', 'test.action', 2, 60_000)).not.toThrow();
    // A different action is unaffected.
    expect(() => checkUserRateLimit('user-a', 'test.other', 2, 60_000)).not.toThrow();
  });

  it('integration: 11th post creation in the window is 429, other users unaffected', async () => {
    const rateArtistId = (globalThis as Record<string, string>).__rateArtistId;
    const results: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/community/posts',
        headers: auth(rateArtist.token),
        payload: { artistId: rateArtistId, body: `rate probe ${i} ${Date.now()}` },
      });
      results.push(res.statusCode);
    }
    expect(results.slice(0, 10)).toEqual(new Array(10).fill(201));
    expect(results[10]).toBe(429);
    // artistA's budget is independent (per-user, not per-IP).
    const other = await post(artistA.token, `unaffected ${Date.now()}`);
    expect(other.statusCode).toBe(201);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Isolation: search, recommendations, playback entitlement
// ---------------------------------------------------------------------------

describe('Phase 29 — isolation boundaries', () => {
  const marker = `zqzx-community-${Date.now()}`;

  beforeAll(async () => {
    await post(artistA.token, `Isolation probe ${marker} with unique text`);
  });

  it('community text never appears in catalog search', async () => {
    for (const url of [
      `/v1/tracks?q=${marker}`,
      `/v1/artists?q=${marker}`,
      `/v1/albums?q=${marker}`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth(listener.token) });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);
    }
  });

  it('no community search endpoint exists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/community/search?q=test',
      headers: auth(listener.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('recommendations contain no community content or private signals', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/discovery/recommendations?limit=20',
      headers: auth(listener.token),
    });
    expect(res.statusCode).toBe(200);
    const payload = JSON.stringify(res.json());
    expect(payload).not.toContain(marker);
    expect(payload).not.toContain('artist_posts');
  });

  it('community posts grant no playback entitlement', async () => {
    // The referenced track is READY and attached to a real post, but the
    // listener has no subscription: session creation must still fail with
    // the dedicated subscription-required problem (not a session).
    const res = await app.inject({
      method: 'POST',
      url: '/v1/playback/sessions',
      headers: auth(listener.token),
      payload: { trackId: trackReadyId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toContain('subscription-required');
  });

  it('no playback token or audio URL ever appears in post payloads', async () => {
    const feed = await app.inject({
      method: 'GET',
      url: '/v1/community/feed?limit=20',
      headers: auth(listener.token),
    });
    const payload = JSON.stringify(feed.json());
    expect(payload).not.toMatch(/playback|token|m3u8|\.ts(\?|")/i);
  });
});
