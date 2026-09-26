// Phase 29 — PostCard tests: rendering, moderation pill, attachments, and
// action callbacks.

import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ArtistPost } from '../../api';
import { PostCard } from '../components/PostCard';

function makePost(overrides: Partial<ArtistPost> = {}): ArtistPost {
  return {
    id: 'post-1',
    body: 'New single out Friday!',
    author: { id: 'user-1', displayName: 'The Band', avatarUrl: null },
    artist: { id: 'artist-1', name: 'The Band', verified: false },
    track: null,
    album: null,
    status: 'ACTIVE',
    reactionCount: 5,
    commentCount: 2,
    viewerReacted: false,
    publishedAt: '2026-09-26T10:00:00.000Z',
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    ...overrides,
  };
}

describe('PostCard', () => {
  it('renders the artist name, body, and counts', () => {
    render(<PostCard post={makePost()} testID="card" />);
    expect(screen.getByText('The Band')).toBeTruthy();
    expect(screen.getByText('New single out Friday!')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('fires onOpen when the card body is pressed', () => {
    const onOpen = jest.fn();
    render(<PostCard post={makePost()} onOpen={onOpen} testID="card" />);
    fireEvent.press(screen.getByTestId('card-open'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'post-1' }));
  });

  it('fires onToggleReaction when the heart is pressed', () => {
    const onToggleReaction = jest.fn();
    render(<PostCard post={makePost()} onToggleReaction={onToggleReaction} testID="card" />);
    fireEvent.press(screen.getByTestId('card-like'));
    expect(onToggleReaction).toHaveBeenCalledWith(expect.objectContaining({ id: 'post-1' }));
  });

  it('shows a status pill for non-ACTIVE posts', () => {
    render(<PostCard post={makePost({ status: 'REMOVED' })} testID="card" />);
    expect(screen.getByText('REMOVED')).toBeTruthy();
  });

  it('renders the attached track chip and plays it on press', () => {
    const onPlayTrack = jest.fn();
    render(
      <PostCard
        post={makePost({
          track: {
            id: 'track-1',
            title: 'Hit Song',
            artistName: 'The Band',
            durationMs: 180000,
            albumTitle: 'Debut',
          },
        })}
        onPlayTrack={onPlayTrack}
        testID="card"
      />,
    );
    expect(screen.getByText('Hit Song')).toBeTruthy();
    fireEvent.press(screen.getByTestId('card-track'));
    expect(onPlayTrack).toHaveBeenCalledWith(expect.objectContaining({ id: 'post-1' }));
  });

  it('marks the liked state for assistive tech', () => {
    render(<PostCard post={makePost({ viewerReacted: true })} testID="card" />);
    expect(screen.getByTestId('card-like').props.accessibilityState).toMatchObject({
      selected: true,
    });
  });
});
