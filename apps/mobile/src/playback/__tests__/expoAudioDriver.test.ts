// Phase 10 — expoAudioDriver wiring tests.
//
// The driver is a thin adapter over the mocked expo-audio module. These pin
// the background-audio contract: the audio-mode flags handed to the OS and
// the now-playing / lock-screen registration mapping. They do not test
// expo-audio's native behavior itself (needs a device; see PHASE-10-REPORT).

import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { createExpoAudioDriver } from '../expoAudioDriver';

const mockedCreatePlayer = jest.mocked(createAudioPlayer);
const mockedSetAudioMode = jest.mocked(setAudioModeAsync);

function lastCreatedPlayer() {
  const results = mockedCreatePlayer.mock.results;
  if (results.length === 0) {
    throw new Error('expected createAudioPlayer to have been called');
  }
  return results[results.length - 1].value as {
    setActiveForLockScreen: jest.Mock;
    clearLockScreenControls: jest.Mock;
  };
}

describe('expoAudioDriver (Phase 10)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('configures background-capable audio mode on initialize', async () => {
    const driver = createExpoAudioDriver();

    await driver.initialize();

    expect(mockedSetAudioMode).toHaveBeenCalledTimes(1);
    expect(mockedSetAudioMode).toHaveBeenCalledWith({
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
      shouldPlayInBackground: true,
    });
  });

  it('registers the player for lock-screen controls with track metadata', async () => {
    const driver = createExpoAudioDriver();
    await driver.load('https://api.example.test/stream.m3u8');

    driver.setNowPlaying({
      title: 'Song One',
      artist: 'Artist',
      albumTitle: 'Album One',
      artworkUrl: 'https://img.test/a.png',
    });

    expect(lastCreatedPlayer().setActiveForLockScreen).toHaveBeenCalledTimes(1);
    expect(lastCreatedPlayer().setActiveForLockScreen).toHaveBeenCalledWith(true, {
      title: 'Song One',
      artist: 'Artist',
      albumTitle: 'Album One',
      artworkUrl: 'https://img.test/a.png',
    });
  });

  it('maps missing optional metadata to undefined, never null', async () => {
    const driver = createExpoAudioDriver();
    await driver.load('https://api.example.test/stream.m3u8');

    driver.setNowPlaying({ title: 'Song One' });

    const metadata = lastCreatedPlayer().setActiveForLockScreen.mock.calls[0][1];
    expect(metadata?.title).toBe('Song One');
    expect(metadata?.artist).toBeUndefined();
    expect(metadata?.albumTitle).toBeUndefined();
    expect(metadata?.artworkUrl).toBeUndefined();
  });

  it('clears the lock-screen controls when now-playing is null', async () => {
    const driver = createExpoAudioDriver();
    await driver.load('https://api.example.test/stream.m3u8');

    driver.setNowPlaying(null);

    expect(lastCreatedPlayer().clearLockScreenControls).toHaveBeenCalledTimes(1);
    expect(lastCreatedPlayer().setActiveForLockScreen).not.toHaveBeenCalled();
  });

  it('ignores setNowPlaying when no player is loaded', () => {
    const driver = createExpoAudioDriver();

    expect(() => driver.setNowPlaying({ title: 'Song One' })).not.toThrow();
    expect(() => driver.setNowPlaying(null)).not.toThrow();
    expect(mockedCreatePlayer).not.toHaveBeenCalled();
  });
});
