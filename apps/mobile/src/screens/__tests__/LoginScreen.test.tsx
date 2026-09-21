// Phase 5 — LoginScreen component tests.
// AuthProvider is wired with in-memory storage and an injected fetch stub so
// no network or native modules are involved.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AuthProvider, createMemoryStorage } from '../../auth';
import { LoginScreen } from '../LoginScreen';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const authPayload = {
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
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresIn: 900,
  },
};

function renderLogin(fetchImpl: (url: string, init: RequestInit) => Promise<unknown>) {
  const fetchFn = jest.fn(fetchImpl) as unknown as typeof fetch;
  const renderResult = render(
    <AuthProvider
      storage={createMemoryStorage()}
      baseUrl="http://api.test"
      fetchFn={fetchFn}
    >
      <LoginScreen />
    </AuthProvider>,
  );
  return { ...renderResult, fetchFn };
}

async function submit() {
  fireEvent.press(screen.getByTestId('login-submit'));
}

describe('LoginScreen', () => {
  it('shows field errors for empty input without calling the API', async () => {
    const { fetchFn } = renderLogin(async () => jsonResponse(200, authPayload));

    await submit();

    await screen.findByText('Email is required.');
    await screen.findByText('Password is required.');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('shows an inline error for a malformed email', async () => {
    const { fetchFn } = renderLogin(async () => jsonResponse(200, authPayload));

    fireEvent.changeText(screen.getByTestId('login-email'), 'not-an-email');
    fireEvent.changeText(screen.getByTestId('login-password'), 'some-password');
    await submit();

    await screen.findByText('Enter a valid email address.');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('clears a field error once the user edits the field', async () => {
    renderLogin(async () => jsonResponse(200, authPayload));

    await submit();
    await screen.findByText('Email is required.');

    fireEvent.changeText(screen.getByTestId('login-email'), 'fan@example.com');
    await waitFor(() => {
      expect(screen.queryByText('Email is required.')).toBeNull();
    });
  });

  it('posts credentials to /v1/auth/login on valid input', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    renderLogin(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, authPayload);
    });

    fireEvent.changeText(screen.getByTestId('login-email'), 'fan@example.com');
    fireEvent.changeText(screen.getByTestId('login-password'), 'twelve-chars!!');
    await submit();

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0].url).toBe('http://api.test/v1/auth/login');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      email: 'fan@example.com',
      password: 'twelve-chars!!',
    });
  });

  it('shows a server error banner on invalid credentials', async () => {
    renderLogin(async () =>
      jsonResponse(401, {
        title: 'Unauthorized',
        status: 401,
        detail: 'Invalid email or password.',
      }),
    );

    fireEvent.changeText(screen.getByTestId('login-email'), 'fan@example.com');
    fireEvent.changeText(screen.getByTestId('login-password'), 'wrong-password!');
    await submit();

    const banner = await screen.findByTestId('login-error-banner');
    expect(banner).toBeTruthy();
    await screen.findByText('Invalid email or password.');
  });

  it('shows a connectivity message when the server is unreachable', async () => {
    renderLogin(async () => {
      throw new Error('fetch failed');
    });

    fireEvent.changeText(screen.getByTestId('login-email'), 'fan@example.com');
    fireEvent.changeText(screen.getByTestId('login-password'), 'twelve-chars!!');
    await submit();

    await screen.findByText('Could not reach the server. Check your connection and try again.');
  });
});
