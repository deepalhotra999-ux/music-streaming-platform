// Phase 29 — community API wrappers: each function hits the right
// /v1/community path with the right method and body. The ApiClient is
// mocked; these tests pin the contract, not the transport.

import type { ApiClient } from '../client';
import {
  addReaction,
  createComment,
  createPost,
  deleteComment,
  deletePost,
  getPost,
  listArtistPosts,
  listComments,
  listCommunityFeed,
  removeReaction,
  reportCommunityContent,
  updatePost,
} from '../community';

function mockClient(): jest.Mocked<ApiClient> {
  return {
    get: jest.fn(async () => ({})),
    post: jest.fn(async () => ({})),
    patch: jest.fn(async () => ({})),
    delete: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<ApiClient>;
}

describe('community endpoints', () => {
  it('listCommunityFeed hits /v1/community/feed with pagination', async () => {
    const client = mockClient();
    await listCommunityFeed(client, { page: 2, limit: 10 });
    expect(client.get).toHaveBeenCalledWith('/v1/community/feed?page=2&limit=10');
  });

  it('listArtistPosts hits /v1/artists/:id/posts', async () => {
    const client = mockClient();
    await listArtistPosts(client, 'artist-1', { limit: 5 });
    expect(client.get).toHaveBeenCalledWith('/v1/artists/artist-1/posts?limit=5');
  });

  it('createPost posts the artist, body, and attachments', async () => {
    const client = mockClient();
    await createPost(client, { artistId: 'artist-1', body: 'Hello', trackId: 'track-1' });
    expect(client.post).toHaveBeenCalledWith('/v1/community/posts', {
      artistId: 'artist-1',
      body: 'Hello',
      trackId: 'track-1',
    });
  });

  it('getPost hits /v1/community/posts/:id', async () => {
    const client = mockClient();
    await getPost(client, 'post-1');
    expect(client.get).toHaveBeenCalledWith('/v1/community/posts/post-1');
  });

  it('updatePost patches the body', async () => {
    const client = mockClient();
    await updatePost(client, 'post-1', { body: 'Edited' });
    expect(client.patch).toHaveBeenCalledWith('/v1/community/posts/post-1', {
      body: 'Edited',
    });
  });

  it('deletePost deletes the post', async () => {
    const client = mockClient();
    await deletePost(client, 'post-1');
    expect(client.delete).toHaveBeenCalledWith('/v1/community/posts/post-1');
  });

  it('listComments hits the comments endpoint with pagination', async () => {
    const client = mockClient();
    await listComments(client, 'post-1', { page: 1, limit: 20 });
    expect(client.get).toHaveBeenCalledWith('/v1/community/posts/post-1/comments?page=1&limit=20');
  });

  it('createComment posts the body', async () => {
    const client = mockClient();
    await createComment(client, 'post-1', 'Nice!');
    expect(client.post).toHaveBeenCalledWith('/v1/community/posts/post-1/comments', {
      body: 'Nice!',
    });
  });

  it('deleteComment deletes the comment', async () => {
    const client = mockClient();
    await deleteComment(client, 'comment-1');
    expect(client.delete).toHaveBeenCalledWith('/v1/community/comments/comment-1');
  });

  it('addReaction posts a like', async () => {
    const client = mockClient();
    await addReaction(client, 'post-1');
    expect(client.post).toHaveBeenCalledWith('/v1/community/posts/post-1/reactions', {});
  });

  it('removeReaction deletes the like', async () => {
    const client = mockClient();
    await removeReaction(client, 'post-1');
    expect(client.delete).toHaveBeenCalledWith('/v1/community/posts/post-1/reactions');
  });

  it('reportCommunityContent posts to the shared moderation-reports endpoint', async () => {
    const client = mockClient();
    await reportCommunityContent(client, {
      targetType: 'ARTIST_POST',
      targetId: 'post-1',
      reason: 'Spam',
    });
    expect(client.post).toHaveBeenCalledWith('/v1/moderation-reports', {
      targetType: 'ARTIST_POST',
      targetId: 'post-1',
      reason: 'Spam',
    });
  });
});
