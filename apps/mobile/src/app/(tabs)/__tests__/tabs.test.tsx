// Phase 13 — role gating: the Artist tab mounts only for ARTIST
// users, and the (artist) stack redirects everyone else.

import { render, screen } from '@testing-library/react-native';
import { useAuth } from '../../../auth';
import TabsLayout from '../_layout';

jest.mock('../../../auth', () => ({
  useAuth: jest.fn(),
}));

const mockUseAuth = useAuth as jest.Mock;

function mockUser(role: 'LISTENER' | 'ARTIST' | 'ADMIN') {
  mockUseAuth.mockReturnValue({ user: { id: 'u1', role } });
}

describe('Artist tab gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the Artist tab for ARTIST users', () => {
    mockUser('ARTIST');
    render(<TabsLayout />);
    expect(screen.getByTestId('tabs-screen-artist')).toBeTruthy();
  });

  it('hides the Artist tab for LISTENER users', () => {
    mockUser('LISTENER');
    render(<TabsLayout />);
    expect(screen.queryByTestId('tabs-screen-artist')).toBeNull();
  });

  it('hides the Artist tab for ADMIN users', () => {
    mockUser('ADMIN');
    render(<TabsLayout />);
    expect(screen.queryByTestId('tabs-screen-artist')).toBeNull();
  });

  it('keeps the listener tabs for every role', () => {
    for (const role of ['LISTENER', 'ARTIST', 'ADMIN'] as const) {
      mockUser(role);
      const { unmount } = render(<TabsLayout />);
      expect(screen.getByTestId('tabs-screen-index')).toBeTruthy();
      expect(screen.getByTestId('tabs-screen-search')).toBeTruthy();
      expect(screen.getByTestId('tabs-screen-library')).toBeTruthy();
      expect(screen.getByTestId('tabs-screen-profile')).toBeTruthy();
      unmount();
    }
  });
});
