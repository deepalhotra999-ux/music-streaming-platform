// Phase 28 — rooms endpoint wrappers: verify each wrapper calls the right
// path with the right method and body. The ApiClient is mocked; these tests
// pin the contract, not the transport.

import type { ApiClient } from '../client';
import {
  createRoom,
  createRoomInvitation,
  endRoom,
  getRoomState,
  joinRoom,
  leaveRoom,
  listRoomInvitations,
  listRoomMembers,
  revokeRoomInvitation,
} from '../rooms';
import { parseInviteText } from '../../rooms/invite';

function mockClient(): jest.Mocked<ApiClient> {
  return {
    get: jest.fn(async () => ({})),
    post: jest.fn(async () => ({})),
    patch: jest.fn(async () => ({})),
    delete: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<ApiClient>;
}

describe('rooms endpoints', () => {
  it('createRoom posts track ids', async () => {
    const client = mockClient();
    await createRoom(client, { trackIds: ['t1', 't2'] });
    expect(client.post).toHaveBeenCalledWith('/v1/rooms', { trackIds: ['t1', 't2'] });
  });

  it('createRoom posts a playlist snapshot request', async () => {
    const client = mockClient();
    await createRoom(client, { playlistId: 'pl-1' });
    expect(client.post).toHaveBeenCalledWith('/v1/rooms', { playlistId: 'pl-1' });
  });

  it('getRoomState hits the room path', async () => {
    const client = mockClient();
    await getRoomState(client, 'room-1');
    expect(client.get).toHaveBeenCalledWith('/v1/rooms/room-1');
  });

  it('joinRoom posts the invitation token', async () => {
    const client = mockClient();
    await joinRoom(client, 'room-1', 'tok_abc');
    expect(client.post).toHaveBeenCalledWith('/v1/rooms/room-1/join', {
      token: 'tok_abc',
    });
  });

  it('leaveRoom posts to the leave path', async () => {
    const client = mockClient();
    await leaveRoom(client, 'room-1');
    expect(client.post).toHaveBeenCalledWith('/v1/rooms/room-1/leave');
  });

  it('endRoom posts to the end path', async () => {
    const client = mockClient();
    await endRoom(client, 'room-1');
    expect(client.post).toHaveBeenCalledWith('/v1/rooms/room-1/end');
  });

  it('listRoomMembers hits the members path', async () => {
    const client = mockClient();
    await listRoomMembers(client, 'room-1');
    expect(client.get).toHaveBeenCalledWith('/v1/rooms/room-1/members');
  });

  it('createRoomInvitation posts without a body', async () => {
    const client = mockClient();
    await createRoomInvitation(client, 'room-1');
    expect(client.post).toHaveBeenCalledWith('/v1/rooms/room-1/invitations');
  });

  it('listRoomInvitations hits the invitations path', async () => {
    const client = mockClient();
    await listRoomInvitations(client, 'room-1');
    expect(client.get).toHaveBeenCalledWith('/v1/rooms/room-1/invitations');
  });

  it('revokeRoomInvitation deletes the invitation path', async () => {
    const client = mockClient();
    await revokeRoomInvitation(client, 'room-1', 'inv-1');
    expect(client.delete).toHaveBeenCalledWith('/v1/rooms/room-1/invitations/inv-1');
  });
});

describe('parseInviteText', () => {
  const roomId = '123e4567-e89b-12d3-a456-426614174000';
  const token = 'A'.repeat(43);

  it('extracts room id and token from a pasted invite block', () => {
    const text = `Join my listening room!\nRoom: ${roomId}\nToken: ${token}`;
    expect(parseInviteText(text)).toEqual({ roomId, token });
  });

  it('finds the values anywhere in surrounding prose', () => {
    const text = `hey, use this ${token} to join room ${roomId} tonight`;
    expect(parseInviteText(text)).toEqual({ roomId, token });
  });

  it('returns null when the token is missing', () => {
    expect(parseInviteText(`join room ${roomId}`)).toBeNull();
  });

  it('returns null when the room id is missing', () => {
    expect(parseInviteText(`token ${token}`)).toBeNull();
  });

  it('returns null for unrelated text', () => {
    expect(parseInviteText('hello world')).toBeNull();
  });
});
