// Phase 25 — authorization-critical records in SecureStore.
//
// The offline authorization record (expiresAt, pinned audioVersion,
// revocation) is the ONLY thing that gates offline playback. It lives in
// SecureStore so casual local-metadata tampering (editing AsyncStorage)
// cannot extend authorization. Records are written exclusively from
// server responses (authorize / revalidate) — never from user input —
// and the server re-checks everything on the next revalidation anyway.

import * as SecureStore from 'expo-secure-store';
import type { OfflineAuthorizationRecord } from './types';

const keyFor = (trackId: string): string => `offline.authz.v1.${trackId}`;

export async function saveAuthorization(record: OfflineAuthorizationRecord): Promise<void> {
  await SecureStore.setItemAsync(keyFor(record.trackId), JSON.stringify(record));
}

export async function getAuthorization(
  trackId: string,
): Promise<OfflineAuthorizationRecord | null> {
  const raw = await SecureStore.getItemAsync(keyFor(trackId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OfflineAuthorizationRecord;
    if (
      typeof parsed.authorizationId !== 'string' ||
      typeof parsed.expiresAt !== 'string' ||
      typeof parsed.issuedAt !== 'string' ||
      typeof parsed.audioVersion !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function removeAuthorization(trackId: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyFor(trackId));
}

/**
 * Local validity check: the grant is usable for offline playback only
 * inside [issuedAt, expiresAt] and while not revoked. This is a
 * fail-closed local gate; the server revalidates on reconnect and is
 * authoritative for the window.
 */
export function isAuthorizationValid(
  record: OfflineAuthorizationRecord,
  now: number = Date.now(),
): boolean {
  if (record.revokedAt !== null) return false;
  const issued = Date.parse(record.issuedAt);
  const expires = Date.parse(record.expiresAt);
  if (Number.isNaN(issued) || Number.isNaN(expires)) return false;
  return now >= issued && now < expires;
}
