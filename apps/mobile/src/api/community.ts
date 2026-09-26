// Phase 29 — artist/fan community endpoints against the Phase 29 API.
//
// Thin wrappers over ApiClient; the backend owns ordering, visibility
// rules, moderation states, and pagination. Community content references
// catalog rows by id only — no catalog metadata is copied here either.
// Posts never grant playback entitlement; referenced tracks play through
// the shared PlaybackEngine like any other catalog track.

import type { ApiClient } from './client';
import type { Page } from './types';

export type CommunityContentStatus = 'ACTIVE' | 'REMOVED' | 'DELETED';

export interface CommunityAuthor {
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

export interface ArtistPost {
  id: string;
  artist: PostArtistRef;
  author: CommunityAuthor;
  body: string;
  track: PostTrackRef | null;
  album: PostAlbumRef | null;
  status: CommunityContentStatus;
  reactionCount: number;
  commentCount: number;
  /** Null on public (unauthenticated) views; boolean when authenticated. */
  viewerReacted: boolean | null;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PostComment {
  id: string;
  postId: string;
  author: CommunityAuthor;
  body: string;
  status: CommunityContentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePostInput {
  artistId: string;
  body: string;
  trackId?: string;
  albumId?: string;
}

export interface UpdatePostInput {
  body?: string;
  /** null clears the attachment. */
  trackId?: string | null;
  albumId?: string | null;
}

export interface ReactionResult {
  reacted: boolean;
  reactionCount: number;
}

export interface ReportCommunityInput {
  targetType: 'ARTIST_POST' | 'POST_COMMENT';
  targetId: string;
  reason: string;
  details?: string;
}

export interface ModerationReport {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  status: string;
  createdAt: string;
}

export type CommunityQuery = { page?: number; limit?: number };

function toQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

// --- Posts -----------------------------------------------------------------

/** ARTIST only; the artist must be owned by the caller. */
export function createPost(client: ApiClient, input: CreatePostInput) {
  return client.post<ArtistPost>('/v1/community/posts', input);
}

/**
 * Public for ACTIVE posts. 404 for REMOVED posts and for DELETED posts
 * viewed by anyone except the author (ADMIN sees all).
 */
export function getPost(client: ApiClient, postId: string) {
  return client.get<ArtistPost>(`/v1/community/posts/${postId}`);
}

/** Author only; ACTIVE posts. */
export function updatePost(client: ApiClient, postId: string, input: UpdatePostInput) {
  return client.patch<ArtistPost>(`/v1/community/posts/${postId}`, input);
}

/** Author only; soft-delete, idempotent. */
export function deletePost(client: ApiClient, postId: string): Promise<void> {
  return client.delete<void>(`/v1/community/posts/${postId}`);
}

/** Authenticated chronological feed: ACTIVE posts from followed artists. */
export function listCommunityFeed(client: ApiClient, query: CommunityQuery = {}) {
  return client.get<Page<ArtistPost>>(
    `/v1/community/feed${toQueryString({ page: query.page, limit: query.limit })}`,
  );
}

/** Public artist profile posts: ACTIVE only, newest first. */
export function listArtistPosts(client: ApiClient, artistId: string, query: CommunityQuery = {}) {
  return client.get<Page<ArtistPost>>(
    `/v1/artists/${artistId}/posts${toQueryString({ page: query.page, limit: query.limit })}`,
  );
}

// --- Comments ---------------------------------------------------------------

/** ACTIVE posts only, oldest first. */
export function listComments(client: ApiClient, postId: string, query: CommunityQuery = {}) {
  return client.get<Page<PostComment>>(
    `/v1/community/posts/${postId}/comments${toQueryString({ page: query.page, limit: query.limit })}`,
  );
}

export function createComment(client: ApiClient, postId: string, body: string) {
  return client.post<PostComment>(`/v1/community/posts/${postId}/comments`, { body });
}

/** Author only; soft-delete, idempotent. */
export function deleteComment(client: ApiClient, commentId: string): Promise<void> {
  return client.delete<void>(`/v1/community/comments/${commentId}`);
}

// --- Reactions (post likes) --------------------------------------------------

/** Idempotent: reacting twice keeps a single reaction. */
export function addReaction(client: ApiClient, postId: string) {
  return client.post<ReactionResult>(`/v1/community/posts/${postId}/reactions`, {});
}

/** Idempotent: always 200, even when there was no reaction. */
export function removeReaction(client: ApiClient, postId: string) {
  return client.delete<ReactionResult>(`/v1/community/posts/${postId}/reactions`);
}

// --- Reporting (Phase 17 workflow, community targets only) -------------------

export function reportCommunityContent(client: ApiClient, input: ReportCommunityInput) {
  return client.post<ModerationReport>('/v1/moderation-reports', input);
}
