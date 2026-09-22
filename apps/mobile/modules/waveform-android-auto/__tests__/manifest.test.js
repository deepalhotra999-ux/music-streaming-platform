// Phase 24 — static regression tests for the Android Auto native module.
//
// No Android SDK is available in this environment, so these tests assert on
// the module's static inputs (manifest, descriptor, gradle, config, Kotlin
// sources) rather than a compiled artifact. They pin the security- and
// architecture-critical properties of the Android Auto integration:
//
//  - the media service is declared with the right intent filters and no
//    extra capabilities (phone-projected Android Auto only);
//  - no Automotive OS feature, no microphone or other new permissions;
//  - the module is Android-only and cannot touch the iOS/CarPlay path;
//  - the virtual player is built on SimpleBasePlayer and never decodes
//    audio itself (no exoplayer dependency, no second focus owner).
//
// These run in the normal `npm test` pass alongside the JS unit tests.

const fs = require('fs');
const path = require('path');

const MODULE_DIR = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(MODULE_DIR, 'android');
const SRC_DIR = path.join(ANDROID_DIR, 'src/main/java/com/musicstreaming/waveform/auto');

function read(relPath) {
  return fs.readFileSync(path.join(MODULE_DIR, relPath), 'utf8');
}

function readAllKotlin() {
  return fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.kt'))
    .map((f) => fs.readFileSync(path.join(SRC_DIR, f), 'utf8'))
    .join('\n');
}

describe('Android Auto manifest declaration', () => {
  const raw = read('android/src/main/AndroidManifest.xml');
  // Strip XML comments: they document deliberate absences and must not
  // trip the negative assertions below.
  const manifest = raw.replace(/<!--[\s\S]*?-->/g, '');

  test('declares the media library service as exported with mediaPlayback foreground type', () => {
    expect(manifest).toContain(
      'android:name="com.musicstreaming.waveform.auto.WaveformMediaLibraryService"',
    );
    expect(manifest).toContain('android:exported="true"');
    expect(manifest).toContain('android:foregroundServiceType="mediaPlayback"');
  });

  test('advertises the Media3 library-service intent actions', () => {
    expect(manifest).toContain(
      '<action android:name="androidx.media3.session.MediaLibraryService"',
    );
    expect(manifest).toContain('<action android:name="android.media.browse.MediaBrowserService"');
  });

  test('points at the automotive app descriptor', () => {
    expect(manifest).toContain('android:name="com.google.android.gms.car.application"');
    expect(manifest).toContain('android:resource="@xml/automotive_app_desc"');
  });

  test('does not target Android Automotive OS or add permissions', () => {
    expect(manifest).not.toContain('android.hardware.type.automotive');
    expect(manifest).not.toContain('<uses-permission');
    expect(manifest).not.toContain('RECORD_AUDIO');
  });
});

describe('automotive app descriptor', () => {
  const descriptor = read('android/src/main/res/xml/automotive_app_desc.xml');

  test('declares only the media category', () => {
    const uses = [...descriptor.matchAll(/<uses\s+name="([^"]+)"/g)].map((m) => m[1]);
    expect(uses).toEqual(['media']);
  });
});

describe('module boundaries', () => {
  test('is Android-only (iOS/CarPlay untouched)', () => {
    const config = JSON.parse(read('expo-module.config.json'));
    expect(config.platforms).toEqual(['android']);
  });

  test('pins media3-session to expo-audio\u2019s version and includes no decoder', () => {
    const gradle = read('android/build.gradle');
    expect(gradle).toMatch(/androidx\.media3:media3-session:1\.9\.0/);
    expect(gradle).not.toContain('media3-exoplayer');
    expect(gradle).not.toContain('media3-ui');
    expect(gradle).not.toContain('media3-datasource');
  });

  test('no microphone permission or automotive feature anywhere in the module', () => {
    const all = readAllKotlin() + read('android/build.gradle');
    expect(all).not.toContain('RECORD_AUDIO');
    expect(all).not.toContain('android.hardware.type.automotive');
  });
});

describe('virtual player architecture (ADR-018)', () => {
  const sources = readAllKotlin();

  test('AutoPlayer projects through SimpleBasePlayer, not a real player', () => {
    const autoPlayer = fs.readFileSync(path.join(SRC_DIR, 'AutoPlayer.kt'), 'utf8');
    expect(autoPlayer).toMatch(/class AutoPlayer\s*:\s*SimpleBasePlayer\(/);
    expect(autoPlayer).not.toContain('ExoPlayer');
    expect(autoPlayer).not.toContain('MediaPlayer');
  });

  test('no Kotlin source decodes audio or touches ExoPlayer', () => {
    expect(sources).not.toContain('exoplayer');
    expect(sources).not.toContain('ExoPlayer');
  });

  test('service extends MediaLibraryService and publishes the required node ids', () => {
    const service = fs.readFileSync(path.join(SRC_DIR, 'WaveformMediaLibraryService.kt'), 'utf8');
    expect(service).toMatch(/class WaveformMediaLibraryService\s*:\s*MediaLibraryService\(\)/);
    const ids = fs.readFileSync(path.join(SRC_DIR, 'AutoMediaIds.kt'), 'utf8');
    for (const node of ['ROOT', 'HOME', 'RECENT', 'LIKED', 'PLAYLISTS', 'ARTISTS', 'ALBUMS']) {
      expect(ids).toContain(`const val ${node}`);
    }
  });

  test('every event the JS controller subscribes to is declared in the module', () => {
    // Extract the subscribed event names from the JS controller so this
    // test fails if either side drifts.
    const controller = fs.readFileSync(
      path.join(MODULE_DIR, '..', '..', 'src', 'androidauto', 'controller.ts'),
      'utf8',
    );
    const subscribed = [...controller.matchAll(/addListener\('([^']+)'/g)].map((m) => m[1]);
    expect(subscribed.length).toBeGreaterThan(0);
    const module = fs.readFileSync(path.join(SRC_DIR, 'WaveformAndroidAutoModule.kt'), 'utf8');
    for (const event of subscribed) {
      expect(module).toContain(`"${event}"`);
    }
  });
});
