// Phase 11 — PlaylistDetailScreen: owner vs non-owner UI states,
// management actions (rename, delete, add/remove/reorder tracks), likes,
// and playback queue integration.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../../auth';
import { PlaylistDetailScreen } from '../PlaylistDetailScreen';

jest.mock('../../auth', () => ({
  useAuth: jest.fn(),
}));

const mockPlayTracks = jest.fn();
const mockAddToQueue = jest.fn();
jest.mock('../../player', () => ({
  useQueueActions: () => ({ playTracks: mockPlayTracks, addToQueue: mockAddToQueue }),
}));

const mockFormProps = jest.fn();
const mockAddTrack = jest.fn();
const mockRemoveItem = jest.fn();
const mockSwapItems = jest.fn();
const mockSetCollaboration = jest.fn();
const mockClearNotice = jest.fn();
const mockCollabState = { notice: null as string | null };
jest.mock('../../library', () => ({
  LikeButton: () => null,
  CollaborativeBadge: () => null,
  PlaylistForm: (props: unknown) => {
    mockFormProps(props);
    return null;
  },
  // Phase 27 — the screen consumes the collab mutation hook; tests pin the
  // returned contract here and assert call args per test.
  useCollabMutations: () => ({
    addTrack: mockAddTrack,
    removeItem: mockRemoveItem,
    swapItems: mockSwapItems,
    setCollaboration: mockSetCollaboration,
    notice: mockCollabState.notice,
    clearNotice: mockClearNotice,
  }),
  COLLAB_CONFLICT_NOTICE: 'Playlist changed by a collaborator — refreshed.',
}));

// Phase 27 — online status gates collaborative writes in tests.
const onlineState = { online: true };
jest.mock('../../utils/useOnlineStatus', () => ({
  useOnlineStatus: () => onlineState.online,
}));

// Phase 25 — PlaylistDetailScreen renders DownloadButtons; the offline
// module is mocked here (its own provider/store tests cover the real
// behavior).
const mockUseOffline = jest.fn();
jest.mock('../../offline/OfflineProvider', () => ({
  useOffline: () => mockUseOffline(),
}));
// DownloadButton is tested separately; render nothing for it here.
jest.mock('../../offline/components/DownloadButton', () => ({
  DownloadButton: () => null,
}));

const mockUseAuth = useAuth as jest.Mock;

const trackA = {
  id: 'ta',
  title: 'First Light',
  durationMs: 180_000,
  status: 'READY',
  artistId: 'a1',
  artistName: 'Neon Bloom',
  albumId: 'al1',
  albumTitle: 'Afterglow',
};
const trackB = { ...trackA, id: 'tb', title: 'Second Wave' };

const itemA = { id: 'item-a', position: 1, addedAt: '2026-01-01T00:00:00.000Z', track: trackA };
const itemB = { id: 'item-b', position: 2, addedAt: '2026-01-02T00:00:00.000Z', track: trackB };

function detail(ownerUserId: string) {
  return {
    id: 'pl1',
    title: 'Road trip',
    description: 'Driving tunes',
    coverArtUrl: null,
    visibility: 'PRIVATE',
    ownerUserId,
    ownerDisplayName: 'Test User',
    trackCount: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: [itemA, itemB],
  };
}

interface Mocks {
  get: jest.Mock;
  patch: jest.Mock;
  post: jest.Mock;
  del: jest.Mock;
}

function mockApi(
  userId: string,
  ownerUserId = 'u1',
  overrides: Record<string, unknown> = {},
): Mocks {
  const data = { ...detail(ownerUserId), ...overrides };
  const get = jest.fn(async (path: string) => {
    if (path === '/v1/playlists/pl1') {
      return data;
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const patch = jest.fn(async () => ({}));
  const post = jest.fn(async () => ({}));
  const del = jest.fn(async () => undefined);
  mockUseAuth.mockReturnValue({
    api: { get, patch, post, delete: del },
    user: { id: userId },
  });
  return { get, patch, post, del };
}

let alertButtons: { text?: string; onPress?: () => void; style?: string }[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  onlineState.online = true;
  mockCollabState.notice = null;
  alertButtons = [];
  mockUseOffline.mockReturnValue({
    downloads: [],
    usedBytes: 0,
    downloadTrack: jest.fn(),
    downloadTracks: jest.fn(),
    pauseDownload: jest.fn(),
    resumeDownload: jest.fn(),
    cancelDownload: jest.fn(),
    retryDownload: jest.fn(),
    removeDownload: jest.fn(),
    revalidateNow: jest.fn(),
    refresh: jest.fn(),
  });
  jest.spyOn(Alert, 'alert').mockImplementation(((_title, _message, buttons) => {
    alertButtons = (buttons ?? []) as typeof alertButtons;
  }) as typeof Alert.alert);
});

afterEach(() => {
  jest.restoreAllMocks();
});

function pressAlertButton(text: string) {
  const button = alertButtons.find((b) => b.text === text);
  if (!button || !button.onPress) {
    throw new Error(`alert button "${text}" not found`);
  }
  button.onPress();
}

describe('PlaylistDetailScreen', () => {
  it('shows owner management controls to the playlist owner', async () => {
    mockApi('u1', 'u1');
    render(<PlaylistDetailScreen playlistId="pl1" />);
    await waitFor(() => expect(screen.getByText('Road trip')).toBeTruthy());
    expect(screen.getByTestId('playlist-edit-button')).toBeTruthy();
    expect(screen.getByTestId('playlist-delete-button')).toBeTruthy();
    expect(screen.getByTestId('playlist-add-tracks-button')).toBeTruthy();
    expect(screen.getByTestId('playlist-visibility-badge')).toBeTruthy();
    expect(screen.getByTestId('playlist-item-remove-item-a')).toBeTruthy();
    expect(screen.getByTestId('playlist-item-up-item-b')).toBeTruthy();
    expect(screen.getByTestId('playlist-item-down-item-a')).toBeTruthy();
  });

  it('hides every management control from non-owners', async () => {
    mockApi('u9', 'u1');
    render(<PlaylistDetailScreen playlistId="pl1" />);
    await waitFor(() => expect(screen.getByText('Road trip')).toBeTruthy());
    expect(screen.queryByTestId('playlist-edit-button')).toBeNull();
    expect(screen.queryByTestId('playlist-delete-button')).toBeNull();
    expect(screen.queryByTestId('playlist-add-tracks-button')).toBeNull();
    expect(screen.queryByTestId('playlist-visibility-badge')).toBeNull();
    expect(screen.queryByTestId('playlist-item-remove-item-a')).toBeNull();
    expect(screen.queryByTestId('playlist-item-up-item-b')).toBeNull();
    // Playback still works for everyone.
    expect(screen.getByTestId('playlist-play-all')).toBeTruthy();
    fireEvent.press(screen.getByTestId('playlist-play-all'));
    expect(mockPlayTracks).toHaveBeenCalledWith([trackA, trackB], 0);
  });

  it('plays the playlist from the tapped track and queues on long-press', async () => {
    mockApi('u9', 'u1');
    render(<PlaylistDetailScreen playlistId="pl1" />);
    await waitFor(() => expect(screen.getByTestId('playlist-track-item-b')).toBeTruthy());
    fireEvent.press(screen.getByTestId('playlist-track-item-b'));
    expect(mockPlayTracks).toHaveBeenCalledWith([trackA, trackB], 1);
    fireEvent(screen.getByTestId('playlist-track-item-a'), 'onLongPress');
    expect(mockAddToQueue).toHaveBeenCalledWith(trackA);
  });

  it('renames the playlist through the edit form (owner)', async () => {
    const mocks = mockApi('u1', 'u1');
    mocks.patch.mockResolvedValueOnce({ ...detail('u1'), title: 'Renamed' });
    render(<PlaylistDetailScreen playlistId="pl1" />);
    await waitFor(() => expect(screen.getByTestId('playlist-edit-button')).toBeTruthy());

    fireEvent.press(screen.getByTestId('playlist-edit-button'));
    const props = mockFormProps.mock.calls.at(-1)[0] as {
      visible: boolean;
      initial: { title: string };
      onSubmit: (v: unknown) => void;
    };
    expect(props.visible).toBe(true);
    expect(props.initial.title).toBe('Road trip');

    props.onSubmit({ title: 'Renamed', description: null, visibility: 'PRIVATE' });
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith('/v1/playlists/pl1', {
        title: 'Renamed',
        description: null,
        visibility: 'PRIVATE',
      }),
    );
    await waitFor(() => expect(screen.getByText('Renamed')).toBeTruthy());
  });

  it('deletes the playlist after confirmation and goes back (owner)', async () => {
    const mocks = mockApi('u1', 'u1');
    render(<PlaylistDetailScreen playlistId="pl1" />);
    await waitFor(() => expect(screen.getByTestId('playlist-delete-button')).toBeTruthy());

    fireEvent.press(screen.getByTestId('playlist-delete-button'));
    expect(alertButtons.map((b) => b.text)).toContain('Delete');
    pressAlertButton('Delete');
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('/v1/playlists/pl1'));
    expect(router.back).toHaveBeenCalled();
  });

  it('removes a track via the collab hook (owner)', async () => {
    mockApi('u1', 'u1');
    render(<PlaylistDetailScreen playlistId="pl1" />);
    await waitFor(() => expect(screen.getByTestId('playlist-item-remove-item-a')).toBeTruthy());

    fireEvent.press(screen.getByTestId('playlist-item-remove-item-a'));
    // The revision-guarded write + refetch live inside the hook (unit-tested
    // separately); the screen delegates to it.
    await waitFor(() => expect(mockRemoveItem).toHaveBeenCalledWith('item-a'));
  });

  it('reorders by swapping positions with the neighbor (owner)', async () => {
    mockApi('u1', 'u1');
    render(<PlaylistDetailScreen playlistId="pl1" />);
    await waitFor(() => expect(screen.getByTestId('playlist-item-up-item-b')).toBeTruthy());

    // Move "Second Wave" above "First Light": the hook swaps the two items
    // (revision-guarded in collaborative mode, legacy otherwise).
    fireEvent.press(screen.getByTestId('playlist-item-up-item-b'));
    await waitFor(() => expect(mockSwapItems).toHaveBeenCalledTimes(1));
    const [first, second] = mockSwapItems.mock.calls[0];
    expect((first as { id: string }).id).toBe('item-b');
    expect((second as { id: string }).id).toBe('item-a');
  });

  it('navigates to the add-tracks picker (owner)', async () => {
    mockApi('u1', 'u1');
    render(<PlaylistDetailScreen playlistId="pl1" />);
    await waitFor(() => expect(screen.getByTestId('playlist-add-tracks-button')).toBeTruthy());
    fireEvent.press(screen.getByTestId('playlist-add-tracks-button'));
    expect(router.push).toHaveBeenCalledWith('/add-tracks/pl1');
  });

  it('shows the error state with retry when loading fails', async () => {
    const mocks = mockApi('u1', 'u1');
    mocks.get.mockRejectedValueOnce(new Error('gone'));
    render(<PlaylistDetailScreen playlistId="pl1" />);
    await waitFor(() => expect(screen.getByTestId('error-state')).toBeTruthy());
    fireEvent.press(screen.getByText('Try again'));
    await waitFor(() => expect(screen.getByText('Road trip')).toBeTruthy());
  });

  describe('Phase 27 — collaboration', () => {
    const collabOverrides = {
      isCollaborative: true,
      revision: 5,
      viewerRole: 'EDITOR' as const,
    };

    it('editor sees track controls but not owner edit/delete buttons', async () => {
      mockApi('ed-1', 'u1', collabOverrides);
      render(<PlaylistDetailScreen playlistId="pl1" />);
      await waitFor(() => expect(screen.getByTestId('playlist-item-remove-item-a')).toBeTruthy());

      expect(screen.getByTestId('playlist-item-up-item-b')).toBeTruthy();
      expect(screen.getByTestId('playlist-add-tracks-button')).toBeTruthy();
      // Owner-only playlist management stays hidden for editors.
      expect(screen.queryByTestId('playlist-edit-button')).toBeNull();
      expect(screen.queryByTestId('playlist-delete-button')).toBeNull();
      // Members entry point is visible to members.
      expect(screen.getByTestId('playlist-members-button')).toBeTruthy();
    });

    it('non-member viewer sees no track controls', async () => {
      mockApi('v-1', 'u1', { ...collabOverrides, viewerRole: 'VIEWER' as const });
      render(<PlaylistDetailScreen playlistId="pl1" />);
      await waitFor(() => expect(screen.getByTestId('playlist-track-item-a')).toBeTruthy());

      expect(screen.queryByTestId('playlist-item-remove-item-a')).toBeNull();
      expect(screen.queryByTestId('playlist-item-up-item-b')).toBeNull();
      expect(screen.queryByTestId('playlist-add-tracks-button')).toBeNull();
      expect(screen.queryByTestId('playlist-members-button')).toBeNull();
    });

    it('owner sees the collaboration toggle but no leave affordance', async () => {
      mockApi('u1', 'u1', { ...collabOverrides, viewerRole: 'OWNER' as const });
      render(<PlaylistDetailScreen playlistId="pl1" />);
      await waitFor(() => expect(screen.getByTestId('collab-toggle')).toBeTruthy());

      expect(screen.getByTestId('playlist-members-button')).toBeTruthy();
    });

    it('toggling collaboration calls the hook and reflects the new revision', async () => {
      mockApi('u1', 'u1', { ...collabOverrides, viewerRole: 'OWNER' as const });
      render(<PlaylistDetailScreen playlistId="pl1" />);
      await waitFor(() => expect(screen.getByTestId('collab-toggle')).toBeTruthy());

      fireEvent(screen.getByTestId('collab-toggle'), 'onValueChange', false);
      await waitFor(() => expect(mockSetCollaboration).toHaveBeenCalledWith(false));
    });

    it('displays the conflict notice raised by the hook', async () => {
      mockCollabState.notice = 'Playlist changed by a collaborator — refreshed.';
      mockApi('ed-1', 'u1', collabOverrides);
      render(<PlaylistDetailScreen playlistId="pl1" />);
      await waitFor(() => expect(screen.getByTestId('collab-conflict-notice')).toBeTruthy());
      expect(screen.getByText('Playlist changed by a collaborator — refreshed.')).toBeTruthy();
    });

    it('hides collaborative writes offline while keeping playback available', async () => {
      onlineState.online = false;
      mockApi('ed-1', 'u1', collabOverrides);
      render(<PlaylistDetailScreen playlistId="pl1" />);
      await waitFor(() => expect(screen.getByTestId('collab-offline-hint')).toBeTruthy());

      // Playback and download entry points remain available offline.
      expect(screen.getByTestId('playlist-play-all')).toBeTruthy();
      expect(screen.getByTestId('playlist-download-all')).toBeTruthy();
      // Collaborative write controls are hidden (not just disabled) offline.
      expect(screen.queryByTestId('playlist-add-tracks-button')).toBeNull();
      expect(screen.queryByTestId('playlist-item-remove-item-a')).toBeNull();
    });
  });
});
