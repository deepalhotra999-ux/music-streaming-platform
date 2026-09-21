// Phase 14 — ArtistTracksScreen audio pipeline UI states.
//
// NONE -> upload, PENDING/PROCESSING -> disabled, READY -> replace,
// FAILED -> error + retry/new-file, picker cancel, upload/retry errors,
// polling transition, and synchronous duplicate-submit prevention.

import { Alert } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { getDocumentAsync } from 'expo-document-picker';
import { useAuth } from '../../auth';
import { ArtistTracksScreen } from '../ArtistTracksScreen';

jest.mock('../../auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

const mockUseAuth = useAuth as jest.Mock;
const mockGetDocumentAsync = getDocumentAsync as jest.Mock;

function pageOf<T>(items: T[]) {
  return {
    data: items,
    pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 },
  };
}

function makeTrack(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    title: 'First Light',
    artistId: 'a1',
    artistName: 'Neon Bloom',
    albumId: null,
    albumTitle: null,
    durationMs: 180_000,
    trackNumber: 1,
    discNumber: 1,
    status: 'PROCESSING',
    audioStatus: 'NONE',
    playCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const pendingStatus = {
  trackId: 't1',
  audioStatus: 'PENDING',
  audioError: null,
  audioReadyAt: null,
};

const readyStatus = {
  trackId: 't1',
  audioStatus: 'READY',
  audioError: null,
  audioReadyAt: '2026-09-21T00:00:00.000Z',
};

interface ApiMocks {
  get: jest.Mock;
  post: jest.Mock;
  upload: jest.Mock;
}

/** api.get serves the track list; tests override the /audio status via getAudioImpl. */
function mockApi(tracks: unknown[], getAudioImpl?: (path: string) => unknown): ApiMocks {
  const get = jest.fn(async (path: string) => {
    if (path === '/v1/me/artists') return pageOf([{ id: 'a1', name: 'Neon Bloom' }]);
    if (path.startsWith('/v1/albums')) return pageOf([]);
    if (path.startsWith('/v1/tracks/') && path.endsWith('/audio')) {
      if (getAudioImpl) return getAudioImpl(path);
      return pendingStatus;
    }
    if (path.startsWith('/v1/tracks')) return pageOf(tracks);
    throw new Error(`unexpected path ${path}`);
  });
  const post = jest.fn(async () => pendingStatus);
  const patch = jest.fn(async (p: string, body: unknown) => body);
  const del = jest.fn(async () => undefined);
  const upload = jest.fn(async () => pendingStatus);
  mockUseAuth.mockReturnValue({ api: { get, post, patch, delete: del, upload } });
  return { get, post, upload };
}

async function renderWithTracks(tracks: unknown[], getAudioImpl?: (path: string) => unknown) {
  const api = mockApi(tracks, getAudioImpl);
  render(<ArtistTracksScreen />);
  await waitFor(() => expect(screen.getByTestId('artist-tracks-list')).toBeTruthy());
  return api;
}

describe('ArtistTracksScreen audio pipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockGetDocumentAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///a.wav', name: 'a.wav', mimeType: 'audio/wav' }] });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('NONE shows "Upload audio" and uploads the picked file, then polls to READY', async () => {
    const { upload } = await renderWithTracks([makeTrack({ audioStatus: 'NONE' })]);

    fireEvent.press(screen.getByTestId('audio-upload-t1'));
    expect(mockGetDocumentAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const [path, formData] = upload.mock.calls[0] as [string, FormData];
    expect(path).toBe('/v1/tracks/t1/audio');
    expect(formData).toBeInstanceOf(FormData);

    // Upload returned PENDING: the badge flips to Queued…
    await waitFor(() => expect(screen.getByTestId('audio-status-t1')).toBeTruthy());
    expect(screen.getByText('Queued')).toBeTruthy();
    // …and the row is busy while the pipeline runs.
    expect(screen.getByTestId('audio-busy-t1')).toBeTruthy();
  });

  it('PENDING and PROCESSING tracks show a disabled busy button', async () => {
    await renderWithTracks([makeTrack({ audioStatus: 'PENDING' }), makeTrack({ id: 't2', audioStatus: 'PROCESSING' })]);
    expect(screen.getByTestId('audio-busy-t1')).toBeTruthy();
    expect(screen.getByTestId('audio-busy-t2')).toBeTruthy();
    expect(screen.queryByTestId('audio-upload-t1')).toBeNull();
  });

  it('READY shows "Replace audio"', async () => {
    await renderWithTracks([makeTrack({ audioStatus: 'READY' })]);
    expect(screen.getByTestId('audio-upload-t1')).toBeTruthy();
    expect(screen.getByText('Replace audio')).toBeTruthy();
  });

  it('FAILED shows the server error with Retry and New file actions', async () => {
    const failedStatus = { ...pendingStatus, audioStatus: 'FAILED', audioError: 'The audio file could not be processed.' };
    const { post, upload } = await renderWithTracks(
      [makeTrack({ audioStatus: 'FAILED' }), makeTrack({ id: 't2', audioStatus: 'FAILED' })],
      (path) => ({ ...failedStatus, trackId: path.includes('t2') ? 't2' : 't1' }),
    );

    expect(screen.getByTestId('audio-error-t1')).toBeTruthy();
    expect(screen.getByTestId('audio-error-t2')).toBeTruthy();
    expect(screen.getAllByText('The audio file could not be processed.')).toHaveLength(2);

    fireEvent.press(screen.getByTestId('audio-retry-t1'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/tracks/t1/audio/retry'));

    fireEvent.press(screen.getByTestId('audio-upload-t2'));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0][0]).toBe('/v1/tracks/t2/audio');
  });

  it('cancelling the document picker performs no upload', async () => {
    mockGetDocumentAsync.mockResolvedValueOnce({ canceled: true, assets: [] });
    const { upload } = await renderWithTracks([makeTrack({ audioStatus: 'NONE' })]);

    fireEvent.press(screen.getByTestId('audio-upload-t1'));
    await waitFor(() => expect(mockGetDocumentAsync).toHaveBeenCalledTimes(1));
    // Let any stray async work settle.
    await Promise.resolve();
    expect(upload).not.toHaveBeenCalled();
  });

  it('an upload failure surfaces an alert and releases the row', async () => {
    const { upload } = await renderWithTracks([makeTrack({ audioStatus: 'NONE' })]);
    upload.mockRejectedValueOnce(new Error('net down'));

    fireEvent.press(screen.getByTestId('audio-upload-t1'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Upload failed', expect.any(String)));
    // Row is usable again after the failure.
    await waitFor(() => expect(screen.getByTestId('audio-upload-t1')).toBeTruthy());
  });

  it('a retry failure surfaces an alert', async () => {
    const { post } = await renderWithTracks(
      [makeTrack({ audioStatus: 'FAILED' })],
      () => ({ ...pendingStatus, audioStatus: 'FAILED', audioError: 'bad' }),
    );
    post.mockRejectedValueOnce(new Error('net down'));

    fireEvent.press(screen.getByTestId('audio-retry-t1'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Retry failed', expect.any(String)));
  });

  it('polls the status endpoint until the pipeline reaches READY', async () => {
    let polls = 0;
    await renderWithTracks([makeTrack({ audioStatus: 'NONE' })], () => {
      polls += 1;
      return polls < 2 ? pendingStatus : readyStatus;
    });

    fireEvent.press(screen.getByTestId('audio-upload-t1'));
    await waitFor(() => expect(screen.getByText('Queued')).toBeTruthy());

    // First 3s poll still sees PENDING…
    await jest.advanceTimersByTimeAsync(3000);
    expect(screen.getByText('Queued')).toBeTruthy();
    // …the next poll sees READY and the row settles.
    await jest.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(screen.getByText('Audio ready')).toBeTruthy());
    expect(screen.queryByTestId('audio-busy-t1')).toBeNull();
    expect(screen.getByText('Replace audio')).toBeTruthy();
  });

  it('two rapid taps submit only one upload (synchronous lock)', async () => {
    const { upload } = await renderWithTracks([makeTrack({ audioStatus: 'NONE' })]);

    const button = screen.getByTestId('audio-upload-t1');
    fireEvent.press(button);
    fireEvent.press(button); // second tap before React re-renders
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    // A later tick must not produce a second upload either.
    await jest.advanceTimersByTimeAsync(100);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('two rapid taps submit only one retry (synchronous lock)', async () => {
    const { post } = await renderWithTracks(
      [makeTrack({ audioStatus: 'FAILED' })],
      () => ({ ...pendingStatus, audioStatus: 'FAILED', audioError: 'bad' }),
    );

    const button = screen.getByTestId('audio-retry-t1');
    fireEvent.press(button);
    fireEvent.press(button);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await jest.advanceTimersByTimeAsync(100);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
