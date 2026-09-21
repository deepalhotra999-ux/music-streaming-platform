// Phase 5 — AuthProvider integration tests.
// Verifies the full session lifecycle: sign-in persists, a fresh provider
// restores the persisted session, and sign-out clears it.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { AuthProvider, createMemoryStorage, loadSession, useAuth } from '../index';
import type { KeyValueStorage } from '../index';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const user = {
  id: 'user-1',
  email: 'fan@example.com',
  displayName: 'Fan',
  avatarUrl: null,
  role: 'LISTENER',
  emailVerified: false,
  countryCode: null,
  createdAt: '2026-09-21T00:00:00.000Z',
};

const loginPayload = {
  user,
  tokens: { tokenType: 'Bearer', accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 900 },
};

function Probe() {
  const { status, user: currentUser, signIn, signOut } = useAuth();
  return (
    <>
      <Text testID="probe-status">{status}</Text>
      <Text testID="probe-user">{currentUser?.email ?? 'none'}</Text>
      <Text testID="probe-signin" onPress={() => signIn('fan@example.com', 'twelve-chars!!')}>
        signin
      </Text>
      <Text testID="probe-signout" onPress={() => signOut()}>
        signout
      </Text>
    </>
  );
}

function renderProbe(storage: KeyValueStorage, fetchImpl: (url: string) => Promise<unknown>) {
  return render(
    <AuthProvider
      storage={storage}
      baseUrl="http://api.test"
      fetchFn={jest.fn(fetchImpl) as unknown as typeof fetch}
    >
      <Probe />
    </AuthProvider>,
  );
}

async function settleTo(expectedStatus: 'authenticated' | 'unauthenticated') {
  await waitFor(
    () => {
      expect(screen.getByTestId('probe-status').props.children).toBe(expectedStatus);
    },
    { timeout: 5000 },
  );
}

describe('AuthProvider', () => {
  it('starts unauthenticated with empty storage', async () => {
    renderProbe(createMemoryStorage(), async () => jsonResponse(200, loginPayload));
    await settleTo('unauthenticated');
    expect(screen.getByTestId('probe-user').props.children).toBe('none');
  });

  it('signIn persists the session and surfaces the user', async () => {
    const storage = createMemoryStorage();
    renderProbe(storage, async (url) => {
      if (url.endsWith('/v1/auth/logout')) {
        return jsonResponse(204, null);
      }
      return jsonResponse(200, loginPayload);
    });

    await settleTo('unauthenticated');
    fireEvent.press(screen.getByTestId('probe-signin'));
    await settleTo('authenticated');

    expect(screen.getByTestId('probe-user').props.children).toBe('fan@example.com');
    const stored = await loadSession(storage);
    expect(stored?.tokens.accessToken).toBe('access-1');
    expect(stored?.user.email).toBe('fan@example.com');
  });

  it('restores a persisted session on launch via /v1/me', async () => {
    const storage = createMemoryStorage();
    const first = renderProbe(storage, async () => jsonResponse(200, loginPayload));
    await settleTo('unauthenticated');
    fireEvent.press(screen.getByTestId('probe-signin'));
    await settleTo('authenticated');
    first.unmount();

    // Fresh provider with the same storage: the mount effect must restore.
    const calls: string[] = [];
    render(
      <AuthProvider
        storage={storage}
        baseUrl="http://api.test"
        fetchFn={
          jest.fn(async (url: string) => {
            calls.push(url);
            return jsonResponse(200, user);
          }) as unknown as typeof fetch
        }
      >
        <Probe />
      </AuthProvider>,
    );
    await settleTo('authenticated');
    expect(calls).toContain('http://api.test/v1/me');
    expect(screen.getByTestId('probe-user').props.children).toBe('fan@example.com');
  });

  it('signOut revokes the refresh token and clears local state', async () => {
    const storage = createMemoryStorage();
    const logoutCalls: string[] = [];
    renderProbe(storage, async (url) => {
      if (url.endsWith('/v1/auth/logout')) {
        logoutCalls.push(url);
        return jsonResponse(204, null);
      }
      return jsonResponse(200, loginPayload);
    });

    await settleTo('unauthenticated');
    fireEvent.press(screen.getByTestId('probe-signin'));
    await settleTo('authenticated');

    fireEvent.press(screen.getByTestId('probe-signout'));
    await settleTo('unauthenticated');

    expect(logoutCalls).toEqual(['http://api.test/v1/auth/logout']);
    expect(await loadSession(storage)).toBeNull();
  });

  it('signOut still clears local state when revocation fails', async () => {
    const storage = createMemoryStorage();
    renderProbe(storage, async (url) => {
      if (url.endsWith('/v1/auth/logout')) {
        throw new Error('network down');
      }
      return jsonResponse(200, loginPayload);
    });

    await settleTo('unauthenticated');
    fireEvent.press(screen.getByTestId('probe-signin'));
    await settleTo('authenticated');

    fireEvent.press(screen.getByTestId('probe-signout'));
    await settleTo('unauthenticated');
    expect(await loadSession(storage)).toBeNull();
  });
});
