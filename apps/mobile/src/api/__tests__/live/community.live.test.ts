// Phase 29 — LIVE integration test: the full community journey against the
// real Phase 29 API.
//
// ARTIST creates posts (with/without a track attachment), LISTENER follows
// and sees the feed, comments/reactions round-trip, LISTENER cannot post,
// authors edit/delete their own posts, and others cannot. Throwaway users
// are registered per run and everything created is cleaned up in afterAll.
//
// Run explicitly with `npm run test:live` (requires the API on
// EXPO_PUBLIC_API_URL, default http://localhost:3000, and the dev
// database).

import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { promisify } from 'util';
import http from 'http';
import {
  addReaction,
  ApiClient,
  ApiError,
  createArtist,
  createComment,
  createPost,
  deleteArtist,
  deleteComment,
  deletePost,
  followArtist,
  getApiBaseUrl,
  getPost,
  listArtistPosts,
  listComments,
  listCommunityFeed,
  login,
  register,
  removeReaction,
  updatePost,
} from '../../index';

const execFileAsync = promisify(execFile);

function nodeHttpFetch(url: string, init?: RequestInit): Promise<Response> {
  const target = new URL(url);
  const headers: Record<string, string> = {};
  const rawHeaders = init?.headers as Record<string, string> | undefined;
  if (rawHeaders) {
    for (const [key, value] of Object.entries(rawHeaders)) {
      headers[key] = value;
    }
  }
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString('utf8');
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          resolvePromise({
            ok: status >= 200 && status < 300,
            status,
            json: async () => (data.length > 0 ? JSON.parse(data) : null),
          } as Response);
        });
      },
    );
    req.on('error', reject);
    if (init?.body) {
      req.write(init.body as string);
    }
    req.end();
  });
}

const fetchFn = nodeHttpFetch as unknown as typeof fetch;
const anon = new ApiClient({ baseUrl: getApiBaseUrl(), fetchFn });

const API_DIR = resolve(__dirname, '../../../../../../services/api');

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = resolve(API_DIR, '.env');
  if (!existsSync(envPath)) {
    throw new Error('DATABASE_URL is not set and services/api/.env was not found');
  }
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL not found in services/api/.env');
  return line.slice('DATABASE_URL='.length);
}

/** Promote a throwaway test user; role changes are admin-only via the API. */
async function setRole(email: string, role: 'LISTENER' | 'ARTIST'): Promise<void> {
  await execFileAsync('node', [resolve(API_DIR, 'scripts/set-user-role.mjs'), email, role], {
    env: { ...process.env, DATABASE_URL: loadDatabaseUrl() },
  });
}

function authedClient(accessToken: string): ApiClient {
  return new ApiClient({ baseUrl: getApiBaseUrl(), fetchFn, getAccessToken: () => accessToken });
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('live artist-fan community', () => {
  const RUN_ID = Date.now().toString(36);
  const ARTIST_EMAIL = `waveform-community-artist-${RUN_ID}@example.com`;
  const LISTENER_EMAIL = `waveform-community-listener-${RUN_ID}@example.com`;
  const PASSWORD = 'CommunityLive-Pass-123!';

  let artist: ApiClient;
  let listener: ApiClient;
  let artistId = '';
  let postId = '';
  let commentId = '';

  beforeAll(async () => {
    for (const [email, displayName] of [
      [ARTIST_EMAIL, 'Community Artist Test'],
      [LISTENER_EMAIL, 'Community Listener Test'],
    ] as const) {
      await register(anon, { email, password: PASSWORD, displayName });
    }
    await setRole(ARTIST_EMAIL, 'ARTIST');

    const a = await login(anon, { email: ARTIST_EMAIL, password: PASSWORD });
    expect(a.user.role).toBe('ARTIST');
    artist = authedClient(a.tokens.accessToken);

    const b = await login(anon, { email: LISTENER_EMAIL, password: PASSWORD });
    listener = authedClient(b.tokens.accessToken);

    const created = await createArtist(artist, { name: `Community Artist ${RUN_ID}` });
    artistId = created.id;
  }, 60000);

  it('ARTIST creates a post; LISTENER is denied', async () => {
    const post = await createPost(artist, {
      artistId,
      body: `Live community post ${RUN_ID}`,
    });
    postId = post.id;
    expect(post.body).toBe(`Live community post ${RUN_ID}`);
    expect(post.artist.id).toBe(artistId);
    expect(post.status).toBe('ACTIVE');
    expect(post.author.displayName).toBe('Community Artist Test');
    // Safe public DTO: no email, no role, no private fields.
    expect(post.author).not.toHaveProperty('email');

    await expectStatus(createPost(listener, { artistId, body: 'nope' }), 403);
  });

  it('LISTENER follows the artist and sees the post in the feed', async () => {
    const empty = await listCommunityFeed(listener, { limit: 20 });
    expect(empty.data.map((p) => p.id)).not.toContain(postId);

    await followArtist(listener, artistId);

    const feed = await listCommunityFeed(listener, { limit: 20 });
    const found = feed.data.find((p) => p.id === postId);
    expect(found).toBeDefined();
    expect(found?.body).toBe(`Live community post ${RUN_ID}`);
  });

  it('artist profile lists the post publicly', async () => {
    const page = await listArtistPosts(listener, artistId, { limit: 20 });
    expect(page.data.map((p) => p.id)).toContain(postId);
  });

  it('comments round-trip; only the author can delete', async () => {
    const comment = await createComment(listener, postId, `Great news ${RUN_ID}!`);
    commentId = comment.id;
    expect(comment.body).toBe(`Great news ${RUN_ID}!`);

    const page = await listComments(listener, postId, { limit: 20 });
    expect(page.data.map((c) => c.id)).toContain(commentId);

    // The artist is not the comment author → 403.
    await expectStatus(deleteComment(artist, commentId), 403);
    await deleteComment(listener, commentId);

    const after = await listComments(listener, postId, { limit: 20 });
    expect(after.data.map((c) => c.id)).not.toContain(commentId);
    commentId = '';
  });

  it('reactions are idempotent and toggle', async () => {
    const first = await addReaction(listener, postId);
    expect(first.reacted).toBe(true);
    const count = first.reactionCount;

    const again = await addReaction(listener, postId);
    expect(again.reacted).toBe(true);
    expect(again.reactionCount).toBe(count);

    const removed = await removeReaction(listener, postId);
    expect(removed.reacted).toBe(false);
    expect(removed.reactionCount).toBe(count - 1);

    const post = await getPost(listener, postId);
    expect(post.viewerReacted).toBe(false);
  });

  it('author edits their own post; others cannot', async () => {
    const updated = await updatePost(artist, postId, {
      body: `Edited live post ${RUN_ID}`,
    });
    expect(updated.body).toBe(`Edited live post ${RUN_ID}`);

    await expectStatus(updatePost(listener, postId, { body: 'hijack' }), 403);
  });

  it('author deletes their post; it disappears from the feed', async () => {
    await deletePost(artist, postId);

    const feed = await listCommunityFeed(listener, { limit: 20 });
    expect(feed.data.map((p) => p.id)).not.toContain(postId);
    await expectStatus(getPost(listener, postId), 404);
  });

  afterAll(async () => {
    if (commentId) await deleteComment(listener, commentId).catch(() => {});
    if (postId) await deletePost(artist, postId).catch(() => {});
    if (artistId) await deleteArtist(artist, artistId).catch(() => {});
  });
});
