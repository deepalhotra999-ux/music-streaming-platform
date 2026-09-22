// Phase 27 — CollaborativeBadge: collaborative marker with optional role.

import { render, screen } from '@testing-library/react-native';
import { CollaborativeBadge } from '../CollaborativeBadge';

describe('CollaborativeBadge', () => {
  it('renders the collaborative marker without a role', () => {
    render(<CollaborativeBadge />);
    expect(screen.getByText('Collaborative')).toBeTruthy();
  });

  it('renders the role when given', () => {
    render(<CollaborativeBadge viewerRole="EDITOR" />);
    expect(screen.getByText('Collaborative • Editor')).toBeTruthy();
  });

  it('forwards the testID', () => {
    render(<CollaborativeBadge testID="badge-x" />);
    expect(screen.getByTestId('badge-x')).toBeTruthy();
  });
});
