// Phase 7 — playback endpoint wrappers: verify each wrapper calls the right
// path with the right body. The ApiClient is mocked; these tests pin the
// contract, not the transport.

import type { ApiClient } from '../client';
import { createPlaybackSession, reportPlayEvent } from '../playback';

function mockClient(): jest.Mocked<ApiClient> {
  return {
    get: jest.fn(async () => ({})),
    post: jest.fn(async () => ({})),
  } as unknown as jest.Mocked<ApiClient>;
}

describe('playback endpoints', () => {
  it('createPlaybackSession posts the track id', async () => {
    const client = mockClient();
    await createPlaybackSession(client, 'track-1');
    expect(client.post).toHaveBeenCalledWith('/v1/playback/sessions', { trackId: 'track-1' });
  });

  it('reportPlayEvent posts to the session events path', async () => {
    const client = mockClient();
    await reportPlayEvent(client, 'session-1', 'HEARTBEAT', 12345);
    expect(client.post).toHaveBeenCalledWith('/v1/playback/sessions/session-1/events', {
      type: 'HEARTBEAT',
      positionMs: 12345,
    });
  });

  it('reportPlayEvent omits positionMs when not provided', async () => {
    const client = mockClient();
    await reportPlayEvent(client, 'session-1', 'START');
    expect(client.post).toHaveBeenCalledWith('/v1/playback/sessions/session-1/events', {
      type: 'START',
    });
  });
});
