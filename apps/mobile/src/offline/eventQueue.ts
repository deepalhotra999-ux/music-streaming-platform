// Phase 25 — offline play-event queue.
//
// Events from offline playback are persisted to AsyncStorage immediately
// (never held only in memory) and uploaded when connectivity returns.
// Uploads are idempotent per event key: the server accepts replayed keys
// without duplicating rows, so a failed flush can simply retry.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import type { ApiClient } from '../api';
import { ApiError } from '../api';
import { syncOfflineEvents } from './api';
import type { QueuedOfflineEvent } from './types';

const QUEUE_KEY = 'offline.events.queue.v1';
const MAX_BATCH = 100;

async function readQueue(): Promise<QueuedOfflineEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeQueue(events: QueuedOfflineEvent[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(events));
}

export function newEventKey(): string {
  return Crypto.randomUUID();
}

export async function enqueueOfflineEvent(
  event: Omit<QueuedOfflineEvent, 'key' | 'occurredAt'> & { occurredAt?: string },
): Promise<QueuedOfflineEvent> {
  const full: QueuedOfflineEvent = {
    ...event,
    key: newEventKey(),
    occurredAt: event.occurredAt ?? new Date().toISOString(),
  };
  const queue = await readQueue();
  queue.push(full);
  await writeQueue(queue);
  return full;
}

export async function queuedEventCount(): Promise<number> {
  return (await readQueue()).length;
}

export interface FlushResult {
  uploaded: number;
  rejected: { key: string; reason: string }[];
  /** True when the flush should be retried later (network/server error). */
  retryable: boolean;
}

/**
 * Upload queued events in batches. Accepted keys are dropped; rejected
 * keys are dropped too (the server judged them invalid — retrying cannot
 * help) and returned for logging. Only network/server failures are
 * retryable.
 */
export async function flushOfflineEvents(api: ApiClient): Promise<FlushResult> {
  const queue = await readQueue();
  const result: FlushResult = { uploaded: 0, rejected: [], retryable: false };
  while (queue.length > 0) {
    const batch = queue.slice(0, MAX_BATCH);
    let response;
    try {
      response = await syncOfflineEvents(api, batch);
    } catch (error) {
      // Auth failures (401/403) mean the session is dead — the caller
      // handles sign-out; the queue stays intact for the next account.
      // Everything else (network, 5xx) is retryable.
      if (error instanceof ApiError && (error.isUnauthorized || error.status === 403)) {
        result.retryable = false;
        break;
      }
      result.retryable = true;
      break;
    }
    const accepted = new Set(response.accepted);
    const rejectedKeys = new Set(response.rejected.map((r) => r.key));
    result.uploaded += response.accepted.length;
    result.rejected.push(...response.rejected);
    const remaining = queue.filter((e) => !accepted.has(e.key) && !rejectedKeys.has(e.key));
    queue.length = 0;
    queue.push(...remaining);
    await writeQueue(queue);
    // A batch that uploaded nothing new but also failed nothing means the
    // server state is unclear — stop to avoid a hot loop.
    if (response.accepted.length === 0 && response.rejected.length === 0) {
      result.retryable = true;
      break;
    }
  }
  return result;
}

/** Test/dev helper: clear the queue. */
export async function clearOfflineEvents(): Promise<void> {
  await AsyncStorage.removeItem(QUEUE_KEY);
}

export function __testOnly(): { readQueue: typeof readQueue; writeQueue: typeof writeQueue } {
  return { readQueue, writeQueue };
}
