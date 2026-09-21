// Phase 14 — AudioStatusBadge: one label per ingestion state.

import { render, screen } from '@testing-library/react-native';
import { AudioStatusBadge } from '../components/AudioStatusBadge';
import type { AudioIngestStatus } from '../../api';

const EXPECTED: Record<AudioIngestStatus, string> = {
  NONE: 'No audio',
  PENDING: 'Queued',
  PROCESSING: 'Processing',
  READY: 'Audio ready',
  FAILED: 'Audio failed',
};

describe('AudioStatusBadge', () => {
  it.each(Object.entries(EXPECTED))('renders "%s" for %s', (status, label) => {
    render(<AudioStatusBadge status={status as AudioIngestStatus} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByTestId(`audio-status-badge-${status}`)).toBeTruthy();
  });

  it('accepts a custom testID', () => {
    render(<AudioStatusBadge status="READY" testID="custom-badge" />);
    expect(screen.getByTestId('custom-badge')).toBeTruthy();
  });
});
