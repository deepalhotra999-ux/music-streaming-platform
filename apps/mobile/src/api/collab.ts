// Phase 27 — collaborative playlist endpoints against the Phase 27 API.
//
// Ownership/membership are always server-derived from the Bearer token:
// no wrapper accepts a client-supplied actor, owner, or member identity.
// Track mutations on collaborative playlists carry `expectedRevision`
// (optimistic concurrency); the server bumps the revision atomically and
// returns it in the `x-playlist-revision` response header, never in the
// item body.

import type { ApiClient } from './client';
import type {
  CollaborationSettings,
  CreateInvitationResult,
  PlaylistChange,
  PlaylistDetail,
  PlaylistInvitation,
  PlaylistItem,
  PlaylistMember,
} from './types';

/** Response header carrying the new playlist revision after a mutation. */
export const PLAYLIST_REVISION_HEADER = 'x-playlist-revision';

function readRevision(headers: Headers): number {
  const raw = headers.get(PLAYLIST_REVISION_HEADER);
  const revision = raw === null ? NaN : Number(raw);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error(`Missing or invalid ${PLAYLIST_REVISION_HEADER} response header.`);
  }
  return revision;
}

/** A mutation result paired with the authoritative new revision. */
export interface RevisionedResult<T> {
  data: T;
  revision: number;
}

// --- Collaboration settings ------------------------------------------------

/** Owner only. Disabling removes all members and revokes invitations. */
export function setCollaborationEnabled(
  client: ApiClient,
  playlistId: string,
  enabled: boolean,
): Promise<CollaborationSettings> {
  return client.patch<CollaborationSettings>(`/v1/playlists/${playlistId}/collaboration`, {
    enabled,
  });
}

// --- Members ---------------------------------------------------------------

/** Members only; the owner is listed first with role OWNER. */
export function listMembers(client: ApiClient, playlistId: string): Promise<PlaylistMember[]> {
  return client.get<PlaylistMember[]>(`/v1/playlists/${playlistId}/members`);
}

/** Editors only; the owner cannot leave. Resolves on 204. */
export function leavePlaylist(client: ApiClient, playlistId: string): Promise<void> {
  return client.delete<void>(`/v1/playlists/${playlistId}/members/me`);
}

/** Owner only. The owner can never be removed. Resolves on 204. */
export function removeMember(
  client: ApiClient,
  playlistId: string,
  memberUserId: string,
): Promise<void> {
  return client.delete<void>(`/v1/playlists/${playlistId}/members/${memberUserId}`);
}

// --- Invitations ------------------------------------------------------------

/**
 * Owner only. Returns the raw token exactly once — it is never stored
 * server-side (only its SHA-256 hash) and never appears again.
 */
export function createInvitation(
  client: ApiClient,
  playlistId: string,
): Promise<CreateInvitationResult> {
  return client.post<CreateInvitationResult>(`/v1/playlists/${playlistId}/invitations`);
}

/** Owner only. Invitation rows never contain tokens. */
export function listInvitations(
  client: ApiClient,
  playlistId: string,
): Promise<PlaylistInvitation[]> {
  return client.get<PlaylistInvitation[]>(`/v1/playlists/${playlistId}/invitations`);
}

/** Owner only. Already-used invitations cannot be revoked. Resolves on 204. */
export function revokeInvitation(
  client: ApiClient,
  playlistId: string,
  invitationId: string,
): Promise<void> {
  return client.delete<void>(`/v1/playlists/${playlistId}/invitations/${invitationId}`);
}

/**
 * Join a collaborative playlist with an invitation token. The accepting
 * user is derived from the session — the token alone grants nothing.
 * Returns the joined playlist's detail (the caller becomes an EDITOR).
 */
export function acceptInvitation(client: ApiClient, token: string): Promise<PlaylistDetail> {
  return client.post<PlaylistDetail>('/v1/playlists/invitations/accept', { token: token.trim() });
}

// --- Change history ---------------------------------------------------------

/** Members only; append-only, newest first. */
export function listPlaylistChanges(
  client: ApiClient,
  playlistId: string,
  limit?: number,
): Promise<PlaylistChange[]> {
  const query = limit === undefined ? '' : `?limit=${limit}`;
  return client.get<PlaylistChange[]>(`/v1/playlists/${playlistId}/changes${query}`);
}

// --- Revision-guarded track mutations ---------------------------------------
// For collaborative playlists only. Non-collaborative playlists keep using
// the legacy wrappers in library.ts (no revision required).

export interface CollaborativeMutation {
  expectedRevision: number;
}

export async function addTrackCollaborative(
  client: ApiClient,
  playlistId: string,
  input: { trackId: string; position?: number } & CollaborativeMutation,
): Promise<RevisionedResult<PlaylistItem>> {
  const { data, headers } = await client.postWithHeaders<PlaylistItem>(
    `/v1/playlists/${playlistId}/tracks`,
    input,
  );
  return { data, revision: readRevision(headers) };
}

export async function movePlaylistItemCollaborative(
  client: ApiClient,
  playlistId: string,
  itemId: string,
  input: { position: number } & CollaborativeMutation,
): Promise<RevisionedResult<PlaylistItem>> {
  const { data, headers } = await client.patchWithHeaders<PlaylistItem>(
    `/v1/playlists/${playlistId}/tracks/${itemId}`,
    input,
  );
  return { data, revision: readRevision(headers) };
}

export async function removePlaylistItemCollaborative(
  client: ApiClient,
  playlistId: string,
  itemId: string,
  expectedRevision: number,
): Promise<number> {
  const { headers } = await client.deleteWithHeaders<void>(
    `/v1/playlists/${playlistId}/tracks/${itemId}`,
    { expectedRevision },
  );
  return readRevision(headers);
}
