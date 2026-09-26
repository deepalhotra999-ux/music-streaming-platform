// Release tooling — useAppUpdates tests.
//
// The expo-updates native module is fully mocked: these pin the hook's state
// machine (idle → checking → downloading → ready, up-to-date, error,
// unavailable) and the auto-check-on-mount behavior. They do not test
// expo-updates itself (needs a release build; see docs/RELEASES.md).

import { act, render } from '@testing-library/react-native';
import { useAppUpdates, type AppUpdates } from '../useAppUpdates';

const mockCheckForUpdateAsync = jest.fn<Promise<{ isAvailable: boolean }>, []>();
const mockFetchUpdateAsync = jest.fn<Promise<{ isNew: boolean }>, []>();
const mockReloadAsync = jest.fn<Promise<void>, []>();

let mockIsEnabled = true;

jest.mock('expo-updates', () => ({
  get isEnabled() {
    return mockIsEnabled;
  },
  checkForUpdateAsync: () => mockCheckForUpdateAsync(),
  fetchUpdateAsync: () => mockFetchUpdateAsync(),
  reloadAsync: () => mockReloadAsync(),
  channel: 'production',
  updateId: 'abcdef12-3456-7890-abcd-ef1234567890',
  runtimeVersion: '1.0.0',
  createdAt: new Date('2026-09-26T00:00:00.000Z'),
  isEmbeddedLaunch: false,
  isEmergencyLaunch: false,
}));

let captured: AppUpdates | null = null;
function Probe() {
  captured = useAppUpdates();
  return null;
}

async function renderProbe() {
  captured = null;
  render(<Probe />);
  // Flush the mount-effect's async check.
  await act(async () => {});
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsEnabled = true;
  mockCheckForUpdateAsync.mockResolvedValue({ isAvailable: false });
  mockFetchUpdateAsync.mockResolvedValue({ isNew: true });
});

describe('useAppUpdates', () => {
  it('reports unavailable and never checks when updates are disabled', async () => {
    mockIsEnabled = false;
    await renderProbe();
    expect(captured!.state).toBe('unavailable');
    expect(mockCheckForUpdateAsync).not.toHaveBeenCalled();
  });

  it('auto-checks on mount and reports up-to-date', async () => {
    await renderProbe();
    expect(mockCheckForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(captured!.state).toBe('up-to-date');
  });

  it('downloads and becomes ready when an update is available', async () => {
    mockCheckForUpdateAsync.mockResolvedValue({ isAvailable: true });
    await renderProbe();
    expect(captured!.state).toBe('ready');
    expect(mockFetchUpdateAsync).toHaveBeenCalledTimes(1);
  });

  it('applies a ready update via reloadAsync', async () => {
    mockCheckForUpdateAsync.mockResolvedValue({ isAvailable: true });
    await renderProbe();
    await act(async () => {
      await captured!.applyUpdate();
    });
    expect(mockReloadAsync).toHaveBeenCalledTimes(1);
  });

  it('reports error when the check throws', async () => {
    mockCheckForUpdateAsync.mockRejectedValue(new Error('network down'));
    await renderProbe();
    expect(captured!.state).toBe('error');
    expect(captured!.error).toBe('network down');
  });

  it('supports a manual check after settling', async () => {
    await renderProbe();
    expect(captured!.state).toBe('up-to-date');
    mockCheckForUpdateAsync.mockResolvedValue({ isAvailable: true });
    await act(async () => {
      await captured!.checkNow();
    });
    expect(captured!.state).toBe('ready');
    expect(mockCheckForUpdateAsync).toHaveBeenCalledTimes(2);
  });

  it('exposes the running update info', async () => {
    await renderProbe();
    expect(captured!.info.channel).toBe('production');
    expect(captured!.info.updateId).toBe('abcdef12-3456-7890-abcd-ef1234567890');
    expect(captured!.info.runtimeVersion).toBe('1.0.0');
    expect(captured!.info.isEmbeddedLaunch).toBe(false);
  });
});
