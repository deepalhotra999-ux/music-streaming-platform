// Phase 25 — offline play-event queue: durable, idempotent, and
// fail-closed on auth errors.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError } from '../../api';
import {
  __testOnly,
  clearOfflineEvents,
  enqueueOfflineEvent,
  flushOfflineEvents,
  queuedEventCount,
} from '../eventQueue';

jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => `uuid-${Math.random().toString(36).slice(2)}`),
}));

function resetStorage(): void {
  (AsyncStorage as unknown as { __reset: () => void }).__reset();
}

const baseEvent = {
  offlineAuthorizationId: 'authz-1',
  offlineSessionKey: 'sess-1',
  type: 'START' as const,
  positionMs: 0,
};

beforeEach(() => {
  resetStorage();
});

describe('eventQueue', () => {
  it('persists events immediately with unique keys and timestamps', async () => {
    const e1 = await enqueueOfflineEvent(baseEvent);
    const e2 = await enqueueOfflineEvent({ ...baseEvent, type: 'COMPLETE', positionMs: 180000 });
    expect(e1.key).not.toBe(e2.key);
    expect(e1.occurredAt).toBeDefined();
    expect(await queuedEventCount()).toBe(2);
    const stored = await __testOnly().readQueue();
    expect(stored).toHaveLength(2);
  });

  it('flush uploads and clears accepted events', async () => {
    await enqueueOfflineEvent(baseEvent);
    await enqueueOfflineEvent({ ...baseEvent, type: 'HEARTBEAT', positionMs: 15000 });
    const api = {
      post: jest.fn(async () => ({ accepted: ['k1'], rejected: [] })),
    };
    // Keys are random; accept whatever was queued.
    const keys = (await __testOnly().readQueue()).map((e) => e.key);
    api.post.mockResolvedValueOnce({ accepted: keys, rejected: [] });

    const result = await flushOfflineEvents(api as never);
    expect(result.uploaded).toBe(2);
    expect(result.rejected).toHaveLength(0);
    expect(await queuedEventCount()).toBe(0);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('drops server-rejected events without retrying them', async () => {
    const event = await enqueueOfflineEvent(baseEvent);
    const api = {
      post: jest.fn(async () => ({
        accepted: [],
        rejected: [{ key: event.key, reason: 'outside_window' }],
      })),
    };
    const result = await flushOfflineEvents(api as never);
    expect(result.rejected).toHaveLength(1);
    expect(result.retryable).toBe(false);
    expect(await queuedEventCount()).toBe(0);
  });

  it('keeps the queue on network failure and marks retryable', async () => {
    await enqueueOfflineEvent(baseEvent);
    const api = {
      post: jest.fn(async () => {
        throw new ApiError(0, { title: 'Network error' });
      }),
    };
    const result = await flushOfflineEvents(api as never);
    expect(result.retryable).toBe(true);
    expect(result.uploaded).toBe(0);
    expect(await queuedEventCount()).toBe(1);
  });

  it('keeps the queue but does not retry on 401 (session dead)', async () => {
    await enqueueOfflineEvent(baseEvent);
    const api = {
      post: jest.fn(async () => {
        throw new ApiError(401, { title: 'Unauthorized' });
      }),
    };
    const result = await flushOfflineEvents(api as never);
    expect(result.retryable).toBe(false);
    expect(await queuedEventCount()).toBe(1);
  });

  it('is idempotent: replaying an already-accepted key changes nothing', async () => {
    const event = await enqueueOfflineEvent(baseEvent);
    const api = {
      post: jest.fn(async () => ({ accepted: [event.key], rejected: [] })),
    };
    await flushOfflineEvents(api as never);
    // Queue is empty; a second flush sends nothing.
    const result = await flushOfflineEvents(api as never);
    expect(result.uploaded).toBe(0);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('clearOfflineEvents empties the queue', async () => {
    await enqueueOfflineEvent(baseEvent);
    await clearOfflineEvents();
    expect(await queuedEventCount()).toBe(0);
  });
});
