// Phase 13 — the (artist) stack redirects non-ARTIST users (deep-link
// protection on top of the tab gating).

import { render, screen } from '@testing-library/react-native';
import { useAuth } from '../../../auth';
import ArtistLayout from '../_layout';

jest.mock('../../../auth', () => ({
  useAuth: jest.fn(),
}));

const mockUseAuth = useAuth as jest.Mock;

function mockAuth(role: 'LISTENER' | 'ARTIST' | 'ADMIN') {
  mockUseAuth.mockReturnValue({ status: 'authenticated', user: { id: 'u1', role } });
}

describe('Artist stack role guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the stack for ARTIST users', () => {
    mockAuth('ARTIST');
    render(<ArtistLayout />);
    expect(screen.queryByTestId('redirect')).toBeNull();
  });

  it('redirects LISTENER users to the tabs', () => {
    mockAuth('LISTENER');
    render(<ArtistLayout />);
    const redirect = screen.getByTestId('redirect');
    expect(redirect.props.href).toBe('/(tabs)');
  });

  it('redirects ADMIN users to the tabs', () => {
    mockAuth('ADMIN');
    render(<ArtistLayout />);
    const redirect = screen.getByTestId('redirect');
    expect(redirect.props.href).toBe('/(tabs)');
  });
});
