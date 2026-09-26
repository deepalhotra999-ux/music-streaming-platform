// Phase 6 — ArtworkImage component tests.
// Phase 31 — artwork is decorative by default (hidden from the accessibility
// tree to avoid double-announcing inside already-labelled cards), so queries
// include hidden elements; separate tests assert the hiding behavior.

import { render, screen } from '@testing-library/react-native';
import { ArtworkImage } from '../ArtworkImage';

const hidden = { includeHiddenElements: true };

describe('ArtworkImage', () => {
  it('renders a deterministic placeholder with the title initial when no uri', () => {
    render(<ArtworkImage uri={null} title="Neon Bloom" seed="artist-1" size={96} />);
    expect(screen.getByTestId('artwork-placeholder', hidden)).toBeTruthy();
    expect(screen.getByText('N', hidden)).toBeTruthy();
  });

  it('renders the placeholder when the uri is undefined', () => {
    render(<ArtworkImage title="  " seed="x" size={48} />);
    expect(screen.getByText('•', hidden)).toBeTruthy();
  });

  it('renders a remote image when a uri is provided', () => {
    render(
      <ArtworkImage
        uri="https://cdn.example.com/art.png"
        title="Cover"
        seed="album-1"
        size={128}
        testID="artwork-image"
      />,
    );
    expect(screen.getByTestId('artwork-image', hidden)).toBeTruthy();
  });

  it('keeps the same placeholder color for the same seed', () => {
    const { getByTestId, rerender } = render(
      <ArtworkImage uri={null} title="A" seed="same-seed" size={64} />,
    );
    const first = getByTestId('artwork-placeholder', hidden).props.style;
    rerender(<ArtworkImage uri={null} title="A" seed="same-seed" size={64} />);
    expect(getByTestId('artwork-placeholder', hidden).props.style).toEqual(first);
  });

  it('hides the placeholder from the accessibility tree by default', () => {
    render(<ArtworkImage uri={null} title="Neon Bloom" seed="artist-1" size={96} />);
    expect(screen.queryByTestId('artwork-placeholder')).toBeNull();
    expect(screen.queryByText('N')).toBeNull();
  });

  it('exposes the image with the given label when accessibilityLabel is provided', () => {
    render(
      <ArtworkImage
        uri="https://cdn.example.com/art.png"
        title="Cover"
        seed="album-1"
        size={128}
        testID="artwork-image"
        accessibilityLabel="Album artwork for Neon Bloom"
      />,
    );
    const image = screen.getByTestId('artwork-image');
    expect(image.props.accessibilityLabel).toBe('Album artwork for Neon Bloom');
    expect(image.props.accessibilityRole).toBe('image');
  });
});
