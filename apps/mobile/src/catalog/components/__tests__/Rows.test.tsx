// Phase 6 — catalog row component tests.

import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ArtistListItem, TrackListItem } from '../../../api';
import { AlbumTrackRow, ArtistRow, TrackRow } from '../Rows';

const track: TrackListItem = {
  id: 't1',
  title: 'Midnight Drive',
  artistId: 'a1',
  artistName: 'Neon Bloom',
  albumId: 'al1',
  albumTitle: 'Afterglow',
  durationMs: 214000,
  trackNumber: 3,
  discNumber: 1,
  status: 'READY',
  audioStatus: 'READY',
  playCount: 42,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const artist: ArtistListItem = {
  id: 'a1',
  name: 'Neon Bloom',
  verified: true,
  followerCount: 9001,
  createdAt: '2024-01-01T00:00:00.000Z',
};

describe('TrackRow', () => {
  it('renders title, artist, and formatted duration', () => {
    render(<TrackRow track={track} />);
    expect(screen.getByText('Midnight Drive')).toBeTruthy();
    expect(screen.getByText('Neon Bloom')).toBeTruthy();
    expect(screen.getByText('3:34')).toBeTruthy();
  });

  it('shows the position index when provided', () => {
    render(<TrackRow track={track} index={3} />);
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('fires onPress when tapped', () => {
    const onPress = jest.fn();
    render(<TrackRow track={track} onPress={onPress} />);
    fireEvent.press(screen.getByTestId('track-row-t1'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  // Phase 9 — long-press wires add-to-queue from the screens.
  it('fires onLongPress when long-pressed', () => {
    const onLongPress = jest.fn();
    render(<TrackRow track={track} onPress={() => {}} onLongPress={onLongPress} />);
    fireEvent(screen.getByTestId('track-row-t1'), 'longPress');
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});

describe('ArtistRow', () => {
  it('renders the name and follower count', () => {
    const onPress = jest.fn();
    render(<ArtistRow artist={artist} onPress={onPress} />);
    expect(screen.getByText('Neon Bloom')).toBeTruthy();
    expect(screen.getByText('9001 followers')).toBeTruthy();
    fireEvent.press(screen.getByTestId('artist-row-a1'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('AlbumTrackRow', () => {
  const albumTrack = {
    id: 't2',
    title: 'Intro',
    durationMs: 61000,
    trackNumber: 1,
    discNumber: 1,
    status: 'READY',
  };

  it('renders the track number, title, and duration', () => {
    render(<AlbumTrackRow track={albumTrack} artistName="Neon Bloom" index={1} />);
    expect(screen.getByText('Intro')).toBeTruthy();
    expect(screen.getByText('1:01')).toBeTruthy();
  });

  // Phase 9 — album rows are tappable: tap plays, long-press queues.
  it('fires onPress and onLongPress', () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    render(
      <AlbumTrackRow
        track={albumTrack}
        artistName="Neon Bloom"
        index={1}
        onPress={onPress}
        onLongPress={onLongPress}
      />,
    );
    fireEvent.press(screen.getByTestId('album-track-row-t2'));
    expect(onPress).toHaveBeenCalledTimes(1);
    fireEvent(screen.getByTestId('album-track-row-t2'), 'longPress');
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});
