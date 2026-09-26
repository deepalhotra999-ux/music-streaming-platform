// Phase 31 — accessibility behavior tests.
//
// These tests assert *behavioral* semantics (roles, names, states, live
// regions, announcements), not mere prop existence.

import { AccessibilityInfo } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { IconButton } from '../IconButton';
import { TextInput } from '../TextInput';
import { announce } from '../announce';
import { modalAnimationFor } from '../useReducedMotion';

jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});

describe('IconButton', () => {
  it('exposes button role, label, and a 44pt minimum target', () => {
    render(<IconButton icon="heart" label="Like track" testID="like-btn" onPress={() => {}} />);
    const btn = screen.getByTestId('like-btn');
    expect(btn.props.accessibilityRole).toBe('button');
    expect(btn.props.accessibilityLabel).toBe('Like track');
    const style = btn.props.style;
    const flat = Array.isArray(style) ? Object.assign({}, ...style) : style;
    expect(flat.minWidth).toBeGreaterThanOrEqual(44);
    expect(flat.minHeight).toBeGreaterThanOrEqual(44);
  });

  it('hides the decorative icon from the accessibility tree', () => {
    render(<IconButton icon="heart" label="Like track" testID="like-btn" onPress={() => {}} />);
    // The icon itself must not be separately focusable/announced.
    expect(screen.queryByLabelText('heart')).toBeNull();
  });

  it('communicates disabled state', () => {
    render(
      <IconButton icon="heart" label="Like track" testID="like-btn" disabled onPress={() => {}} />,
    );
    expect(screen.getByTestId('like-btn').props.accessibilityState.disabled).toBe(true);
  });
});

describe('TextInput', () => {
  it('includes required state in the accessible name', () => {
    render(<TextInput label="Email" required testID="email" value="" onChangeText={() => {}} />);
    expect(screen.getByTestId('email').props.accessibilityLabel).toBe('Email, required');
  });

  it('includes the current error in the accessible name and exposes an alert', () => {
    render(
      <TextInput
        label="Password"
        required
        error="At least 12 characters"
        testID="password"
        value=""
        onChangeText={() => {}}
      />,
    );
    expect(screen.getByTestId('password').props.accessibilityLabel).toBe(
      'Password, required. At least 12 characters',
    );
    const err = screen.getByTestId('password-error');
    expect(err.props.accessibilityRole).toBe('alert');
    expect(err.props.accessibilityLiveRegion).toBe('assertive');
  });
});

describe('announce', () => {
  it('forwards messages to AccessibilityInfo', () => {
    const spy = AccessibilityInfo.announceForAccessibility as jest.Mock;
    spy.mockClear();
    announce('Download complete');
    expect(spy).toHaveBeenCalledWith('Download complete');
  });
});

describe('modalAnimationFor', () => {
  it('returns none when reduced motion is preferred', () => {
    expect(modalAnimationFor(true, 'slide')).toBe('none');
    expect(modalAnimationFor(true, 'fade')).toBe('none');
  });

  it('returns the normal animation otherwise', () => {
    expect(modalAnimationFor(false, 'slide')).toBe('slide');
    expect(modalAnimationFor(false, 'fade')).toBe('fade');
    expect(modalAnimationFor(false)).toBe('slide');
  });
});
