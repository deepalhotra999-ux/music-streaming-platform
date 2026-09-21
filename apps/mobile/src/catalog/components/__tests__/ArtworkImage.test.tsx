// Phase 6 — ArtworkImage component tests.

import { render, screen } from '@testing-library/react-native';
import { ArtworkImage } from '../ArtworkImage';

describe('ArtworkImage', () => {
  it('renders a deterministic placeholder with the title initial when no uri', () => {
    render(<ArtworkImage uri={null} title="Neon Bloom" seed="artist-1" size={96} />);
    expect(screen.getByTestId('artwork-placeholder')).toBeTruthy();
    expect(screen.getByText('N')).toBeTruthy();
  });

  it('renders the placeholder when the uri is undefined', () => {
    render(<ArtworkImage title="  " seed="x" size={48} />);
    expect(screen.getByText('•')).toBeTruthy();
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
    expect(screen.getByTestId('artwork-image')).toBeTruthy();
  });

  it('keeps the same placeholder color for the same seed', () => {
    const { getByTestId, rerender } = render(
      <ArtworkImage uri={null} title="A" seed="same-seed" size={64} />,
    );
    const first = getByTestId('artwork-placeholder').props.style;
    rerender(<ArtworkImage uri={null} title="A" seed="same-seed" size={64} />);
    expect(getByTestId('artwork-placeholder').props.style).toEqual(first);
  });
});
