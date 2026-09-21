// Phase 5 — Button component tests.

import { fireEvent, render, screen } from '@testing-library/react-native';
import { Button } from '../Button';

describe('Button', () => {
  it('renders its title and fires onPress', () => {
    const onPress = jest.fn();
    render(<Button title="Log in" testID="btn" onPress={onPress} />);

    expect(screen.getByText('Log in')).toBeTruthy();
    fireEvent.press(screen.getByTestId('btn'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not fire onPress when disabled', () => {
    const onPress = jest.fn();
    render(<Button title="Log in" testID="btn" onPress={onPress} disabled />);

    fireEvent.press(screen.getByTestId('btn'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('shows a spinner and blocks presses while loading', () => {
    const onPress = jest.fn();
    render(<Button title="Log in" testID="btn" onPress={onPress} loading />);

    expect(screen.getByTestId('btn-loading')).toBeTruthy();
    fireEvent.press(screen.getByTestId('btn'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('marks disabled state for assistive tech', () => {
    render(<Button title="Log in" testID="btn" onPress={jest.fn()} disabled />);
    expect(screen.getByTestId('btn').props.accessibilityState).toMatchObject({ disabled: true });
  });
});
