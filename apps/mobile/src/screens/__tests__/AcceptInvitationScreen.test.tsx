// Phase 27 — AcceptInvitationScreen: token paste → accept → navigate to
// the joined playlist, only after server success.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AcceptInvitationScreen } from '../AcceptInvitationScreen';

const mockApi = {} as never;
const mockAcceptInvitation = jest.fn();

jest.mock('../../api', () => ({
  __esModule: true,
  ...jest.requireActual('../../api'),
  acceptInvitation: (...args: unknown[]) => mockAcceptInvitation(...args),
  apiErrorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Failed'),
}));

jest.mock('../../auth', () => ({
  useAuth: () => ({ api: mockApi, user: { id: 'me-1' } }),
}));

const onlineState = { online: true };
jest.mock('../../utils/useOnlineStatus', () => ({
  useOnlineStatus: () => onlineState.online,
}));

const mockReplace = jest.fn();
jest.mock('expo-router', () => {
  const actual = jest.requireActual('expo-router');
  return {
    __esModule: true,
    ...actual,
    Stack: { Screen: () => null },
    useRouter: () => ({ replace: mockReplace }),
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  onlineState.online = true;
});

describe('AcceptInvitationScreen', () => {
  it('trims the token, accepts, and navigates to the joined playlist', async () => {
    mockAcceptInvitation.mockResolvedValue({ id: 'pl9' });
    render(<AcceptInvitationScreen />);

    await act(async () => {
      fireEvent.changeText(screen.getByTestId('invitation-token-input'), '  token-xyz  ');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('accept-invitation-button'));
    });

    expect(mockAcceptInvitation).toHaveBeenCalledWith(mockApi, 'token-xyz');
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/playlist/pl9'));
  });

  it('does not navigate on failure and shows the error', async () => {
    mockAcceptInvitation.mockRejectedValue(new Error('Invitation not found'));
    render(<AcceptInvitationScreen />);

    await act(async () => {
      fireEvent.changeText(screen.getByTestId('invitation-token-input'), 'dead-token');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('accept-invitation-button'));
    });

    await waitFor(() => expect(screen.getByTestId('accept-invitation-error')).toBeTruthy());
    expect(screen.getByText('Invitation not found')).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('disables joining while offline', async () => {
    onlineState.online = false;
    render(<AcceptInvitationScreen />);

    expect(screen.getByTestId('accept-offline-hint')).toBeTruthy();
    const button = screen.getByTestId('accept-invitation-button');
    expect(button.props.accessibilityState?.disabled).toBeTruthy();
  });

  it('does not submit with a blank token', async () => {
    render(<AcceptInvitationScreen />);
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('invitation-token-input'), '   ');
    });
    expect(
      screen.getByTestId('accept-invitation-button').props.accessibilityState?.disabled,
    ).toBeTruthy();
  });
});
