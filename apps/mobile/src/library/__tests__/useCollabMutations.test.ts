// Phase 27 — useCollabMutations: revision-guarded collaborative writes,
// conflict recovery (409 → refetch + notice, never claim success), and
// legacy passthrough for non-collaborative playlists.

import { act, renderHook } from '@testing-library/react-native';
import { ApiClient, ApiError } from '../../api/client';
import { COLLAB_CONFLICT_NOTICE, useCollabMutations } from '../useCollabMutations';

const api = {} as ApiClient;

const mockCollab = {
  addTrackCollaborative: jest.fn(),
  movePlaylistItemCollaborative: jest.fn(),
  removePlaylistItemCollaborative: jest.fn(),
  setCollaborationEnabled: jest.fn(),
};
const mockLegacy = {
  addTrackToPlaylist: jest.fn(),
  movePlaylistItem: jest.fn(),
  removePlaylistItem: jest.fn(),
};
const mockReload = jest.fn();

jest.mock('../../api/collab', () => ({
  __esModule: true,
  ...jest.requireActual('../../api/collab'),
  addTrackCollaborative: (...args: unknown[]) => mockCollab.addTrackCollaborative(...args),
  movePlaylistItemCollaborative: (...args: unknown[]) =>
    mockCollab.movePlaylistItemCollaborative(...args),
  removePlaylistItemCollaborative: (...args: unknown[]) =>
    mockCollab.removePlaylistItemCollaborative(...args),
  setCollaborationEnabled: (...args: unknown[]) => mockCollab.setCollaborationEnabled(...args),
}));

jest.mock('../../api/library', () => ({
  __esModule: true,
  ...jest.requireActual('../../api/library'),
  addTrackToPlaylist: (...args: unknown[]) => mockLegacy.addTrackToPlaylist(...args),
  movePlaylistItem: (...args: unknown[]) => mockLegacy.movePlaylistItem(...args),
  removePlaylistItem: (...args: unknown[]) => mockLegacy.removePlaylistItem(...args),
}));

const playlist = (overrides: Record<string, unknown> = {}) => ({
  id: 'pl1',
  title: 'T',
  description: null,
  coverArtUrl: null,
  visibility: 'PRIVATE' as const,
  ownerUserId: 'u1',
  ownerDisplayName: 'U',
  trackCount: 2,
  createdAt: '',
  updatedAt: '',
  items: [],
  isCollaborative: true,
  revision: 5,
  viewerRole: 'OWNER' as const,
  ...overrides,
});

const itemA = { id: 'item-a', position: 0, addedAt: '', track: { id: 'ta' } };
const itemB = { id: 'item-b', position: 1, addedAt: '', track: { id: 'tb' } };

function conflictError(): ApiError {
  return new ApiError(409, {
    title: 'Stale revision',
    status: 409,
    detail: 'Playlist changed by another member.',
  });
}

function renderCollabHook(pl = playlist()) {
  return renderHook(() => useCollabMutations(api, 'pl1', pl as never, mockReload));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('collaborative add', () => {
  it('sends the last-known revision as expectedRevision and reloads on success', async () => {
    mockCollab.addTrackCollaborative.mockResolvedValue({ data: { id: 'i1' }, revision: 6 });
    const { result } = renderCollabHook();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.addTrack('t1');
    });

    expect(mockCollab.addTrackCollaborative).toHaveBeenCalledWith(api, 'pl1', {
      trackId: 't1',
      position: undefined,
      expectedRevision: 5,
    });
    expect(outcome).toBe('ok');
    expect(mockReload).toHaveBeenCalled();
    expect(result.current.notice).toBeNull();
  });

  it('on 409: refetches, raises the notice, and never claims success', async () => {
    mockCollab.addTrackCollaborative.mockRejectedValue(conflictError());
    const { result } = renderCollabHook();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.addTrack('t1');
    });

    expect(outcome).toBe('conflict');
    expect(mockReload).toHaveBeenCalled();
    expect(result.current.notice).toBe(COLLAB_CONFLICT_NOTICE);
  });

  it('routes non-collaborative adds through the legacy endpoint', async () => {
    mockLegacy.addTrackToPlaylist.mockResolvedValue({ id: 'i1' });
    const { result } = renderCollabHook(playlist({ isCollaborative: false }));

    await act(async () => {
      await result.current.addTrack('t1');
    });

    expect(mockLegacy.addTrackToPlaylist).toHaveBeenCalledWith(api, 'pl1', {
      trackId: 't1',
      position: undefined,
    });
    expect(mockCollab.addTrackCollaborative).not.toHaveBeenCalled();
  });
});

describe('collaborative remove', () => {
  it('sends the last-known revision and reloads on success', async () => {
    mockCollab.removePlaylistItemCollaborative.mockResolvedValue(6);
    const { result } = renderCollabHook();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.removeItem('item-a');
    });

    expect(mockCollab.removePlaylistItemCollaborative).toHaveBeenCalledWith(
      api,
      'pl1',
      'item-a',
      5,
    );
    expect(outcome).toBe('ok');
    expect(mockReload).toHaveBeenCalled();
  });

  it('on 409: refetches and reports the conflict notice', async () => {
    mockCollab.removePlaylistItemCollaborative.mockRejectedValue(conflictError());
    const { result } = renderCollabHook();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.removeItem('item-a');
    });

    expect(outcome).toBe('conflict');
    expect(mockReload).toHaveBeenCalled();
    expect(result.current.notice).toBe(COLLAB_CONFLICT_NOTICE);
  });
});

describe('collaborative swap', () => {
  it('threads the returned revision from the first move into the second', async () => {
    mockCollab.movePlaylistItemCollaborative
      .mockResolvedValueOnce({ data: itemA, revision: 6 })
      .mockResolvedValueOnce({ data: itemB, revision: 7 });
    const { result } = renderCollabHook();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.swapItems(itemA as never, itemB as never);
    });

    expect(mockCollab.movePlaylistItemCollaborative).toHaveBeenCalledTimes(2);
    expect(mockCollab.movePlaylistItemCollaborative).toHaveBeenNthCalledWith(
      1,
      api,
      'pl1',
      'item-a',
      { position: 1, expectedRevision: 5 },
    );
    expect(mockCollab.movePlaylistItemCollaborative).toHaveBeenNthCalledWith(
      2,
      api,
      'pl1',
      'item-b',
      { position: 0, expectedRevision: 6 },
    );
    expect(outcome).toBe('ok');
    expect(mockReload).toHaveBeenCalled();
  });

  it('on 409 during the swap: refetches and reports the conflict notice', async () => {
    mockCollab.movePlaylistItemCollaborative.mockRejectedValue(conflictError());
    const { result } = renderCollabHook();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.swapItems(itemA as never, itemB as never);
    });

    expect(outcome).toBe('conflict');
    expect(mockReload).toHaveBeenCalled();
    expect(result.current.notice).toBe(COLLAB_CONFLICT_NOTICE);
  });

  it('routes non-collaborative swaps through the legacy endpoint', async () => {
    const { result } = renderCollabHook(playlist({ isCollaborative: false }));

    await act(async () => {
      await result.current.swapItems(itemA as never, itemB as never);
    });

    expect(mockLegacy.movePlaylistItem).toHaveBeenCalledWith(api, 'pl1', 'item-a', 1);
    expect(mockLegacy.movePlaylistItem).toHaveBeenCalledWith(api, 'pl1', 'item-b', 0);
    expect(mockCollab.movePlaylistItemCollaborative).not.toHaveBeenCalled();
  });
});

describe('collaboration toggle', () => {
  it('enables collaboration and reloads the playlist', async () => {
    mockCollab.setCollaborationEnabled.mockResolvedValue({ id: 'pl1', revision: 6 });
    const { result } = renderCollabHook();

    await act(async () => {
      await result.current.setCollaboration(true);
    });

    expect(mockCollab.setCollaborationEnabled).toHaveBeenCalledWith(api, 'pl1', true);
    expect(mockReload).toHaveBeenCalled();
  });
});

describe('notice management', () => {
  it('clearNotice dismisses the banner', async () => {
    mockCollab.addTrackCollaborative.mockRejectedValue(conflictError());
    const { result } = renderCollabHook();

    await act(async () => {
      await result.current.addTrack('t1');
    });
    expect(result.current.notice).toBe(COLLAB_CONFLICT_NOTICE);

    act(() => {
      result.current.clearNotice();
    });
    expect(result.current.notice).toBeNull();
  });
});
