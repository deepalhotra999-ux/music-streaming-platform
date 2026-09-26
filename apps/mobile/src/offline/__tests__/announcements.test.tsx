// Phase 31 — download announcement hook tests.

import { AccessibilityInfo } from 'react-native';
import { render } from '@testing-library/react-native';
import { useDownloadAnnouncements } from '../useDownloadAnnouncements';
import type { DownloadRecord } from '../types';

jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});

function record(overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    trackId: 't1',
    title: 'First Light',
    artistName: 'Neon Bloom',
    albumTitle: 'Afterglow',
    durationMs: 180_000,
    status: 'downloading',
    bytesWritten: 0,
    totalBytes: null,
    resumeSegment: null,
    authorizationId: null,
    audioVersion: null,
    error: null,
    unavailableReason: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function TestHost({ downloads }: { downloads: DownloadRecord[] }) {
  useDownloadAnnouncements(downloads);
  return null;
}

describe('useDownloadAnnouncements', () => {
  beforeEach(() => {
    (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
  });

  it('announces when a download completes', () => {
    const { rerender } = render(<TestHost downloads={[record()]} />);
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
    rerender(<TestHost downloads={[record({ status: 'complete' })]} />);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      'Download complete: First Light is available offline',
    );
  });

  it('announces download failures', () => {
    const { rerender } = render(<TestHost downloads={[record()]} />);
    rerender(<TestHost downloads={[record({ status: 'failed' })]} />);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      'Download failed: First Light. You can retry from your library.',
    );
  });

  it('does not announce downloads already complete on first load', () => {
    render(<TestHost downloads={[record({ status: 'complete' })]} />);
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
  });

  it('announces each terminal transition only once', () => {
    const { rerender } = render(<TestHost downloads={[record()]} />);
    rerender(<TestHost downloads={[record({ status: 'complete' })]} />);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1);
    rerender(<TestHost downloads={[record({ status: 'complete' })]} />);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1);
  });
});
