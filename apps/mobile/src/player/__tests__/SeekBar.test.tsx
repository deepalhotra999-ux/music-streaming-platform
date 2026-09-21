// Phase 9 — SeekBar tests: the position math is pure and unit-tested; the
// pan-responder commit path is exercised through the view's props.

import { act, render, screen } from '@testing-library/react-native';
import { positionMsForX, SeekBar } from '../SeekBar';

describe('positionMsForX', () => {
  it('maps the left edge to zero and the right edge to the duration', () => {
    expect(positionMsForX(0, 200, 60_000)).toBe(0);
    expect(positionMsForX(200, 200, 60_000)).toBe(60_000);
  });

  it('maps the midpoint proportionally', () => {
    expect(positionMsForX(100, 200, 60_000)).toBe(30_000);
  });

  it('clamps touches outside the bar', () => {
    expect(positionMsForX(-10, 200, 60_000)).toBe(0);
    expect(positionMsForX(250, 200, 60_000)).toBe(60_000);
  });

  it('returns zero when width or duration is not positive', () => {
    expect(positionMsForX(50, 0, 60_000)).toBe(0);
    expect(positionMsForX(50, 200, 0)).toBe(0);
  });
});

function pressAndRelease(seek: ReturnType<typeof screen.getByTestId>, x: number) {
  act(() => {
    seek.props.onLayout({ nativeEvent: { layout: { width: 200 } } });
  });
  act(() => {
    seek.props.onTouchStart({ nativeEvent: { locationX: x } });
  });
  act(() => {
    seek.props.onTouchEnd({ nativeEvent: { locationX: x } });
  });
}

describe('SeekBar', () => {
  it('renders with an accessible seek role', () => {
    render(<SeekBar positionMs={5_000} durationMs={60_000} onSeek={() => {}} />);
    expect(screen.getByLabelText('Seek')).toBeTruthy();
  });

  it('commits a seek on release at the touched position', () => {
    const onSeek = jest.fn();
    render(<SeekBar positionMs={5_000} durationMs={60_000} onSeek={onSeek} />);
    pressAndRelease(screen.getByTestId('seek-bar'), 100);
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(30_000);
  });

  it('does not seek when the touch ends outside the bar bounds', () => {
    const onSeek = jest.fn();
    render(<SeekBar positionMs={5_000} durationMs={60_000} onSeek={onSeek} />);
    pressAndRelease(screen.getByTestId('seek-bar'), 400);
    expect(onSeek).toHaveBeenCalledWith(60_000);
  });

  it('ignores touches while disabled', () => {
    const onSeek = jest.fn();
    render(<SeekBar positionMs={5_000} durationMs={60_000} disabled onSeek={onSeek} />);
    pressAndRelease(screen.getByTestId('seek-bar'), 100);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('adjusts by the accessibility step', () => {
    const onSeek = jest.fn();
    render(<SeekBar positionMs={10_000} durationMs={60_000} onSeek={onSeek} />);
    const seek = screen.getByTestId('seek-bar');
    act(() => {
      seek.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
    });
    expect(onSeek).toHaveBeenCalledWith(15_000);
    act(() => {
      seek.props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } });
    });
    expect(onSeek).toHaveBeenCalledWith(5_000);
  });
});
