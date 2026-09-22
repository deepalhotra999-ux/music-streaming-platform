// Phase 27 — collaborative playlist endpoint wrappers: verify each
// wrapper calls the right path with the right method, body, and header
// handling. The ApiClient is mocked; these tests pin the contract, not
// the transport.

import type { ApiClient } from '../client';
import {
  PLAYLIST_REVISION_HEADER,
  acceptInvitation,
  addTrackCollaborative,
  createInvitation,
  leavePlaylist,
  listInvitations,
  listMembers,
  listPlaylistChanges,
  movePlaylistItemCollaborative,
  removeMember,
  removePlaylistItemCollaborative,
  revokeInvitation,
  setCollaborationEnabled,
} from '../collab';

function mockClient(): jest.Mocked<ApiClient> {
  return {
    get: jest.fn(async () => ({})),
    post: jest.fn(async () => ({})),
    patch: jest.fn(async () => ({})),
    delete: jest.fn(async () => ({})),
    postWithHeaders: jest.fn(async () => ({})),
    patchWithHeaders: jest.fn(async () => ({})),
    deleteWithHeaders: jest.fn(async () => ({})),
  } as unknown as jest.Mocked<ApiClient>;
}

/** Minimal Headers stub: only `get` is exercised by the wrappers. */
function headersStub(revision: string | null): Headers {
  return {
    get: (name: string) => (name === PLAYLIST_REVISION_HEADER ? revision : null),
  } as unknown as Headers;
}

describe('collaboration settings', () => {
  it('setCollaborationEnabled PATCHes the collaboration path with the flag', async () => {
    const client = mockClient();
    (client.patch as jest.Mock).mockResolvedValue({
      id: 'pl1',
      isCollaborative: true,
      revision: 3,
    });
    const result = await setCollaborationEnabled(client, 'pl1', true);
    expect(client.patch).toHaveBeenCalledWith('/v1/playlists/pl1/collaboration', {
      enabled: true,
    });
    expect(result).toEqual({ id: 'pl1', isCollaborative: true, revision: 3 });
  });
});

describe('members', () => {
  it('listMembers targets the members path', async () => {
    const client = mockClient();
    await listMembers(client, 'pl1');
    expect(client.get).toHaveBeenCalledWith('/v1/playlists/pl1/members');
  });

  it('leavePlaylist DELETEs the /me member path', async () => {
    const client = mockClient();
    await leavePlaylist(client, 'pl1');
    expect(client.delete).toHaveBeenCalledWith('/v1/playlists/pl1/members/me');
  });

  it('removeMember DELETEs the member user path', async () => {
    const client = mockClient();
    await removeMember(client, 'pl1', 'u9');
    expect(client.delete).toHaveBeenCalledWith('/v1/playlists/pl1/members/u9');
  });
});

describe('invitations', () => {
  it('createInvitation POSTs and returns the once-only token', async () => {
    const client = mockClient();
    (client.post as jest.Mock).mockResolvedValue({
      token: 'raw-token',
      invitation: { id: 'inv1', expiresAt: '2026-01-01T00:00:00.000Z' },
    });
    const result = await createInvitation(client, 'pl1');
    expect(client.post).toHaveBeenCalledWith('/v1/playlists/pl1/invitations');
    expect(result.token).toBe('raw-token');
  });

  it('listInvitations targets the invitations path', async () => {
    const client = mockClient();
    await listInvitations(client, 'pl1');
    expect(client.get).toHaveBeenCalledWith('/v1/playlists/pl1/invitations');
  });

  it('revokeInvitation DELETEs the invitation path', async () => {
    const client = mockClient();
    await revokeInvitation(client, 'pl1', 'inv1');
    expect(client.delete).toHaveBeenCalledWith('/v1/playlists/pl1/invitations/inv1');
  });

  it('acceptInvitation POSTs the trimmed token to the accept path', async () => {
    const client = mockClient();
    await acceptInvitation(client, '  token-abc  ');
    expect(client.post).toHaveBeenCalledWith('/v1/playlists/invitations/accept', {
      token: 'token-abc',
    });
  });
});

describe('change history', () => {
  it('listPlaylistChanges targets the changes path, with limit when given', async () => {
    const client = mockClient();
    await listPlaylistChanges(client, 'pl1');
    expect(client.get).toHaveBeenCalledWith('/v1/playlists/pl1/changes');
    await listPlaylistChanges(client, 'pl1', 20);
    expect(client.get).toHaveBeenCalledWith('/v1/playlists/pl1/changes?limit=20');
  });
});

describe('revision-guarded track mutations', () => {
  it('addTrackCollaborative sends expectedRevision and reads the revision header', async () => {
    const client = mockClient();
    (client.postWithHeaders as jest.Mock).mockResolvedValue({
      data: { id: 'item-1' },
      headers: headersStub('7'),
    });
    const result = await addTrackCollaborative(client, 'pl1', {
      trackId: 't1',
      expectedRevision: 6,
    });
    expect(client.postWithHeaders).toHaveBeenCalledWith('/v1/playlists/pl1/tracks', {
      trackId: 't1',
      expectedRevision: 6,
    });
    expect(result).toEqual({ data: { id: 'item-1' }, revision: 7 });
  });

  it('movePlaylistItemCollaborative sends position + expectedRevision', async () => {
    const client = mockClient();
    (client.patchWithHeaders as jest.Mock).mockResolvedValue({
      data: { id: 'item-1' },
      headers: headersStub('8'),
    });
    const result = await movePlaylistItemCollaborative(client, 'pl1', 'item-1', {
      position: 3,
      expectedRevision: 7,
    });
    expect(client.patchWithHeaders).toHaveBeenCalledWith('/v1/playlists/pl1/tracks/item-1', {
      position: 3,
      expectedRevision: 7,
    });
    expect(result.revision).toBe(8);
  });

  it('removePlaylistItemCollaborative sends expectedRevision in the DELETE body', async () => {
    const client = mockClient();
    (client.deleteWithHeaders as jest.Mock).mockResolvedValue({
      data: undefined,
      headers: headersStub('9'),
    });
    const revision = await removePlaylistItemCollaborative(client, 'pl1', 'item-1', 8);
    expect(client.deleteWithHeaders).toHaveBeenCalledWith('/v1/playlists/pl1/tracks/item-1', {
      expectedRevision: 8,
    });
    expect(revision).toBe(9);
  });

  it('throws when the revision header is missing', async () => {
    const client = mockClient();
    (client.postWithHeaders as jest.Mock).mockResolvedValue({
      data: { id: 'item-1' },
      headers: headersStub(null),
    });
    await expect(
      addTrackCollaborative(client, 'pl1', { trackId: 't1', expectedRevision: 6 }),
    ).rejects.toThrow(PLAYLIST_REVISION_HEADER);
  });

  it('throws when the revision header is not an integer', async () => {
    const client = mockClient();
    (client.postWithHeaders as jest.Mock).mockResolvedValue({
      data: { id: 'item-1' },
      headers: headersStub('not-a-number'),
    });
    await expect(
      addTrackCollaborative(client, 'pl1', { trackId: 't1', expectedRevision: 6 }),
    ).rejects.toThrow(PLAYLIST_REVISION_HEADER);
  });
});
