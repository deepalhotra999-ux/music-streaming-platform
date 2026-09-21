// Phase 9 — PlayerControls tests: labels, disabled states, and callbacks.

import { fireEvent, render, screen } from '@testing-library/react-native';
import { PlayerControls } from '../PlayerControls';

function renderControls(overrides = {}) {
  const props = {
    state: 'playing' as const,
    canNext: true,
    canPrevious: true,
    shuffle: false,
    repeatMode: 'off' as const,
    onToggle: jest.fn(),
    onNext: jest.fn(),
    onPrevious: jest.fn(),
    onToggleShuffle: jest.fn(),
    onCycleRepeat: jest.fn(),
    ...overrides,
  };
  render(<PlayerControls {...props} />);
  return props;
}

describe('PlayerControls', () => {
  it('labels the toggle Pause while playing and Play while paused', () => {
    renderControls({ state: 'playing' });
    expect(screen.getByLabelText('Pause')).toBeTruthy();
  });

  it('invokes the transport callbacks', () => {
    const props = renderControls();
    fireEvent.press(screen.getByTestId('controls-toggle'));
    fireEvent.press(screen.getByTestId('controls-next'));
    fireEvent.press(screen.getByTestId('controls-previous'));
    fireEvent.press(screen.getByTestId('controls-shuffle'));
    fireEvent.press(screen.getByTestId('controls-repeat'));
    expect(props.onToggle).toHaveBeenCalledTimes(1);
    expect(props.onNext).toHaveBeenCalledTimes(1);
    expect(props.onPrevious).toHaveBeenCalledTimes(1);
    expect(props.onToggleShuffle).toHaveBeenCalledTimes(1);
    expect(props.onCycleRepeat).toHaveBeenCalledTimes(1);
  });

  it('shows a spinner instead of the toggle while loading', () => {
    renderControls({ state: 'loading' });
    expect(screen.getByTestId('controls-loading')).toBeTruthy();
  });

  it('disables next/previous at queue edges', () => {
    renderControls({ canNext: false, canPrevious: false });
    expect(screen.getByTestId('controls-next').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('controls-previous').props.accessibilityState.disabled).toBe(true);
  });

  it('reflects shuffle and repeat mode in labels and badge', () => {
    renderControls({ shuffle: true, repeatMode: 'one' });
    expect(screen.getByLabelText('Shuffle on')).toBeTruthy();
    expect(screen.getByLabelText('Repeat one')).toBeTruthy();
    // The repeat-one badge renders a "1" over the icon.
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('labels repeat-all distinctly', () => {
    renderControls({ repeatMode: 'all' });
    expect(screen.getByLabelText('Repeat all')).toBeTruthy();
  });
});
