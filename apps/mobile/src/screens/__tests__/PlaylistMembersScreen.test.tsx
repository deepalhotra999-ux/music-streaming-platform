// Phase 27 — PlaylistMembersScreen: role-gated member management,
// one-time invitation token display, and offline gating.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Share } from 'react-native';
import { setStringAsync as clipboardSetStringAsync } from 'expo-clipboard';
import { PlaylistMembersScreen } from '../PlaylistMembersScreen';

const mockApi = { post: jest.fn() } as never;

const mockApiFns = {
  listMembers: jest.fn(),
  leavePlaylist: jest.fn(),
  removeMember: jest.fn(),
  createInvitation: jest.fn(),
  listInvitations: jest.fn(),
  revokeInvitation: jest.fn(),
  getPlaylist: jest.fn(),
};
jest.mock('../../api/collab', () => ({
  __esModule: true,
  ...jest.requireActual('../../api/collab'),
  listMembers: (...args: unknown[]) => mockApiFns.listMembers(...args),
  leavePlaylist: (...args: unknown[]) => mockApiFns.leavePlaylist(...args),
  removeMember: (...args: unknown[]) => mockApiFns.removeMember(...args),
  createInvitation: (...args: unknown[]) => mockApiFns.createInvitation(...args),
  listInvitations: (...args: unknown[]) => mockApiFns.listInvitations(...args),
  revokeInvitation: (...args: unknown[]) => mockApiFns.revokeInvitation(...args),
}));

jest.mock('../../api', () => ({
  __esModule: true,
  ...jest.requireActual('../../api'),
  getPlaylist: (...args: unknown[]) => mockApiFns.getPlaylist(...args),
}));

jest.mock('../../auth', () => ({
  useAuth: () => ({ api: mockApi, user: { id: 'me-1', displayName: 'Me' } }),
}));

const mockOnlineState = { online: true };
jest.mock('../../utils/useOnlineStatus', () => ({
  useOnlineStatus: () => mockOnlineState.online,
}));

const mockBack = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => {
  const actual = jest.requireActual('expo-router');
  return {
    __esModule: true,
    ...actual,
    Stack: { Screen: () => null },
    useRouter: () => ({ back: mockBack, replace: mockReplace }),
  };
});

const alertSpy = jest.spyOn(Alert, 'alert');
const shareSpy = jest.spyOn(Share, 'share');

const mockSetStringAsync = clipboardSetStringAsync as jest.Mock;
jest.mock('expo-clipboard', () => ({
  __esModule: true,
  setStringAsync: jest.fn(async () => true),
}));

const member = (overrides: Record<string, unknown> = {}) => ({
  userId: 'me-1',
  displayName: 'Me',
  role: 'OWNER',
  joinedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

function seedOwnerView() {
  mockApiFns.getPlaylist.mockResolvedValue({
    id: 'pl1',
    isCollaborative: true,
    revision: 4,
    viewerRole: 'OWNER',
  });
  mockApiFns.listMembers.mockResolvedValue([
    member(),
    member({ userId: 'ed-1', displayName: 'Eddie', role: 'EDITOR' }),
  ]);
  mockApiFns.listInvitations.mockResolvedValue([]);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOnlineState.online = true;
  seedOwnerView();
});

async function renderScreen() {
  render(<PlaylistMembersScreen playlistId="pl1" />);
  await waitFor(() => expect(screen.getByTestId('member-row-ed-1')).toBeTruthy());
}

describe('PlaylistMembersScreen', () => {
  it('owner sees members, roles, and the invite control', async () => {
    await renderScreen();
    expect(screen.getByTestId('member-row-me-1')).toBeTruthy();
    expect(screen.getByTestId('member-row-ed-1')).toBeTruthy();
    expect(screen.getByText('Owner')).toBeTruthy();
    expect(screen.getByText('Editor')).toBeTruthy();
    expect(screen.getByTestId('create-invitation-button')).toBeTruthy();
  });

  it('creating an invitation shows the token once and hides it on Done', async () => {
    mockApiFns.createInvitation.mockResolvedValue({
      token: 'raw-token-abc',
      invitation: {
        id: 'inv1',
        playlistId: 'pl1',
        createdByUserId: 'me-1',
        createdAt: '2026-09-22T00:00:00.000Z',
        expiresAt: '2026-09-29T00:00:00.000Z',
        acceptedAt: null,
        revokedAt: null,
      },
    });
    await renderScreen();

    await act(async () => {
      fireEvent.press(screen.getByTestId('create-invitation-button'));
    });

    await waitFor(() => expect(screen.getByTestId('invitation-token-card')).toBeTruthy());
    expect(screen.getByText('raw-token-abc')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('invitation-done'));
    });
    await waitFor(() => expect(screen.queryByTestId('invitation-token-card')).toBeNull());
  });

  it('share button opens the system share sheet with the token', async () => {
    mockApiFns.createInvitation.mockResolvedValue({
      token: 'share-me',
      invitation: {
        id: 'inv1',
        playlistId: 'pl1',
        createdByUserId: 'me-1',
        createdAt: '2026-09-22T00:00:00.000Z',
        expiresAt: '2026-09-29T00:00:00.000Z',
        acceptedAt: null,
        revokedAt: null,
      },
    });
    await renderScreen();

    await act(async () => {
      fireEvent.press(screen.getByTestId('create-invitation-button'));
    });
    await waitFor(() => expect(screen.getByTestId('invitation-share')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('invitation-share'));
    });
    expect(shareSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('share-me') }),
    );
  });

  it('copy button writes the token to the clipboard and confirms', async () => {
    mockApiFns.createInvitation.mockResolvedValue({
      token: 'copy-me',
      invitation: {
        id: 'inv1',
        playlistId: 'pl1',
        createdByUserId: 'me-1',
        createdAt: '2026-09-22T00:00:00.000Z',
        expiresAt: '2026-09-29T00:00:00.000Z',
        acceptedAt: null,
        revokedAt: null,
      },
    });
    await renderScreen();

    await act(async () => {
      fireEvent.press(screen.getByTestId('create-invitation-button'));
    });
    await waitFor(() => expect(screen.getByTestId('invitation-copy')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('invitation-copy'));
    });
    await waitFor(() => expect(mockSetStringAsync).toHaveBeenCalledWith('copy-me'));
    expect(alertSpy).toHaveBeenCalledWith('Copied', expect.stringContaining('clipboard'));
  });

  it('copy failure falls back to manual copy guidance', async () => {
    mockApiFns.createInvitation.mockResolvedValue({
      token: 'copy-fail',
      invitation: {
        id: 'inv1',
        playlistId: 'pl1',
        createdByUserId: 'me-1',
        createdAt: '2026-09-22T00:00:00.000Z',
        expiresAt: '2026-09-29T00:00:00.000Z',
        acceptedAt: null,
        revokedAt: null,
      },
    });
    mockSetStringAsync.mockRejectedValueOnce(new Error('no clipboard'));
    await renderScreen();

    await act(async () => {
      fireEvent.press(screen.getByTestId('create-invitation-button'));
    });
    await waitFor(() => expect(screen.getByTestId('invitation-copy')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('invitation-copy'));
    });
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Could not copy', expect.stringContaining('manually')),
    );
  });

  it('editors never request the owner-only invitation list', async () => {
    mockApiFns.getPlaylist.mockResolvedValue({
      id: 'pl1',
      isCollaborative: true,
      revision: 4,
      viewerRole: 'EDITOR',
    });
    mockApiFns.listMembers.mockResolvedValue([
      member({ role: 'OWNER', userId: 'owner-1', displayName: 'Owner' }),
      member({ role: 'EDITOR' }),
    ]);
    render(<PlaylistMembersScreen playlistId="pl1" />);
    await waitFor(() => expect(screen.getByTestId('leave-playlist-button')).toBeTruthy());
    expect(mockApiFns.listInvitations).not.toHaveBeenCalled();
  });

  it('owner removes an editor after confirmation and the member disappears', async () => {
    mockApiFns.removeMember.mockResolvedValue(undefined);
    await renderScreen();
    // After the removal the refetch returns only the owner.
    mockApiFns.listMembers.mockResolvedValue([member()]);

    await act(async () => {
      fireEvent.press(screen.getByTestId('member-remove-ed-1'));
    });
    expect(alertSpy).toHaveBeenCalled();
    const removeHandler = alertSpy.mock.calls[0][2]?.find(
      (button) => button.text === 'Remove',
    )?.onPress;
    expect(removeHandler).toBeDefined();

    await act(async () => {
      await removeHandler?.();
    });
    expect(mockApiFns.removeMember).toHaveBeenCalledWith(mockApi, 'pl1', 'ed-1');
    await waitFor(() => expect(screen.queryByTestId('member-row-ed-1')).toBeNull());
  });

  it('editor sees a Leave button and leaving navigates to my playlists', async () => {
    mockApiFns.getPlaylist.mockResolvedValue({
      id: 'pl1',
      isCollaborative: true,
      revision: 4,
      viewerRole: 'EDITOR',
    });
    mockApiFns.listMembers.mockResolvedValue([
      member({ role: 'OWNER', userId: 'owner-1', displayName: 'Owner' }),
      member({ role: 'EDITOR' }),
    ]);
    mockApiFns.leavePlaylist.mockResolvedValue(undefined);

    render(<PlaylistMembersScreen playlistId="pl1" />);
    await waitFor(() => expect(screen.getByTestId('leave-playlist-button')).toBeTruthy());
    expect(screen.queryByTestId('create-invitation-button')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('leave-playlist-button'));
    });
    const leaveHandler = alertSpy.mock.calls[0][2]?.find(
      (button) => button.text === 'Leave',
    )?.onPress;
    await act(async () => {
      await leaveHandler?.();
    });
    expect(mockApiFns.leavePlaylist).toHaveBeenCalledWith(mockApi, 'pl1');
    expect(mockReplace).toHaveBeenCalledWith('/my-playlists');
  });

  it('owner has no leave button — leaving is not offered to the owner', async () => {
    await renderScreen();
    expect(screen.queryByTestId('leave-playlist-button')).toBeNull();
  });

  it('revokes an active invitation after confirmation and removes it from the list', async () => {
    const invitation = {
      id: 'inv9',
      playlistId: 'pl1',
      createdByUserId: 'me-1',
      createdAt: '2026-09-22T00:00:00.000Z',
      expiresAt: '2026-09-29T00:00:00.000Z',
      acceptedAt: null,
      revokedAt: null,
    };
    mockApiFns.listInvitations.mockResolvedValue([invitation]);
    mockApiFns.revokeInvitation.mockResolvedValue(undefined);
    await renderScreen();
    // After revocation the refetch returns no active invitations.
    mockApiFns.listInvitations.mockResolvedValue([]);

    expect(screen.getByTestId('invitation-revoke-inv9')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('invitation-revoke-inv9'));
    });
    const revokeHandler = alertSpy.mock.calls[0][2]?.find(
      (button) => button.text === 'Revoke',
    )?.onPress;
    expect(revokeHandler).toBeDefined();

    await act(async () => {
      await revokeHandler?.();
    });
    expect(mockApiFns.revokeInvitation).toHaveBeenCalledWith(mockApi, 'pl1', 'inv9');
    await waitFor(() => expect(screen.queryByTestId('invitation-revoke-inv9')).toBeNull());
  });

  it('disables membership writes while offline', async () => {
    mockOnlineState.online = false;
    render(<PlaylistMembersScreen playlistId="pl1" />);
    await waitFor(() => expect(screen.getByTestId('member-row-ed-1')).toBeTruthy());

    const invite = screen.getByTestId('create-invitation-button');
    expect(invite.props.disabled ?? invite.props.accessibilityState?.disabled).toBeTruthy();
    expect(screen.getByTestId('members-offline-hint')).toBeTruthy();
  });
});
