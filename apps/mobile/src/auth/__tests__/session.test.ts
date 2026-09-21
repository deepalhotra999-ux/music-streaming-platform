// Phase 5 — session persistence unit tests.

import type { AuthResult } from '../../api';
import { createMemoryStorage } from '../storage';
import { clearSession, loadSession, saveSession, sessionFromAuthResult } from '../session';
import type { Session } from '../session';

const authResult: AuthResult = {
  user: {
    id: 'user-1',
    email: 'fan@example.com',
    displayName: 'Fan',
    avatarUrl: null,
    role: 'LISTENER',
    emailVerified: false,
    countryCode: null,
    createdAt: '2026-09-21T00:00:00.000Z',
  },
  tokens: {
    tokenType: 'Bearer',
    accessToken: 'access-abc',
    refreshToken: 'refresh-abc',
    expiresIn: 900,
  },
};

describe('session persistence', () => {
  it('round-trips a session through storage', async () => {
    const storage = createMemoryStorage();
    const session = sessionFromAuthResult(authResult);

    await saveSession(storage, session);
    const loaded = await loadSession(storage);

    expect(loaded).toEqual(session);
    expect(loaded?.tokens.accessToken).toBe('access-abc');
    expect(loaded?.user.email).toBe('fan@example.com');
  });

  it('returns null when nothing is stored', async () => {
    expect(await loadSession(createMemoryStorage())).toBeNull();
  });

  it('returns null for corrupt JSON instead of throwing', async () => {
    const storage = createMemoryStorage({ 'com.waveform.session.v1': 'not-json{{' });
    await expect(loadSession(storage)).resolves.toBeNull();
  });

  it('returns null for a well-formed but wrong-shaped document', async () => {
    const storage = createMemoryStorage({
      'com.waveform.session.v1': JSON.stringify({ user: { id: 'x' } }),
    });
    await expect(loadSession(storage)).resolves.toBeNull();
  });

  it('clearSession removes the stored session', async () => {
    const storage = createMemoryStorage();
    await saveSession(storage, sessionFromAuthResult(authResult));

    await clearSession(storage);

    await expect(loadSession(storage)).resolves.toBeNull();
  });

  it('overwrites the previous session (token rotation)', async () => {
    const storage = createMemoryStorage();
    const first: Session = sessionFromAuthResult(authResult);
    const second: Session = {
      ...first,
      tokens: { ...first.tokens, accessToken: 'access-new', refreshToken: 'refresh-new' },
    };

    await saveSession(storage, first);
    await saveSession(storage, second);
    const loaded = await loadSession(storage);

    expect(loaded?.tokens.accessToken).toBe('access-new');
    expect(loaded?.tokens.refreshToken).toBe('refresh-new');
  });
});
