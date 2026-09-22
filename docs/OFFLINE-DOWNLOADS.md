# Offline Downloads & Offline Playback (Phase 25)

How offline downloads work in this codebase: the security boundary, the
API surface, the mobile pipeline, and what must still be proven on real
devices. For the decision record, see `docs/adr/019-offline-downloads.md`.

## The security boundary in one paragraph

A download is a **server-minted, time-bound grant**, not a file copy.
The server issues a short-lived delivery token (60 minutes) to fetch
segments and a separate 30-day offline entitlement window for playback.
Authorization-critical records live in SecureStore and are written only
from server responses; the client can never extend its own window. No
permanent audio URLs ever exist, no credentials are stored with media,
and app-private storage is the OS sandbox — this is obfuscation plus
entitlement, **not DRM**. On a rooted/jailbroken device the audio file
is extractable.

## Backend

Module: `services/api/src/modules/offline/`.

| Endpoint                                                     | Purpose                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `POST /v1/offline/downloads/authorize`                       | Mint (or rotate) a download authorization for a track               |
| `POST /v1/offline/downloads/:id/revalidate`                  | Owner-scoped revalidation; extends the 30-day window while entitled |
| `POST /v1/offline/downloads/:id/revoke`                      | Explicit revocation                                                 |
| `GET /v1/offline/downloads/hls/master.m3u8?token=`           | Token-scoped master playlist                                        |
| `GET /v1/offline/downloads/hls/:rendition/index.m3u8?token=` | Token-scoped rendition playlist                                     |
| `GET /v1/offline/downloads/hls/:rendition/:segment?token=`   | Token-scoped segment bytes (Range/206/416)                          |
| `POST /v1/playback/offline-events`                           | Idempotent upload of queued offline play events (max 500/batch)     |

Rules that matter:

- Delivery tokens are opaque 32-byte values; only SHA-256 hashes are
  stored. Token-scoped manifests are rewritten per request.
- Current track streamability is checked on **every** delivery request —
  a TAKEDOWN mid-download fails the remaining fetches.
- `authorize` is idempotent per (user, track): a live authorization gets
  its delivery token rotated **without extending the window**; a stale
  one (expired, revoked, old audio version) is renewed in place.
- Revalidation extends the window **only while the user stays entitled**.
  `CANCELED` keeps the existing window but never extends it;
  `PAST_DUE`/`EXPIRED`/`REVOKED`/absent entitlement fail closed.
- A track replacement bumps `Track.audioVersion`; the pinned version
  mismatch marks the local download stale and forces re-download.
- Offline events append to the same `play_events` table as online events,
  attached to a synthetic server-side `PlaybackSession` per
  `(userId, offlineSessionKey)` (`tokenHash = null`, never usable for
  streaming). `createdAt` copies `occurredAt`, so analytics bucket
  actual playback time. Phase 15 session/stream/royalty semantics apply
  unchanged, including the 35-second listening-time delta clamp.

## Mobile

Module: `apps/mobile/src/offline/`.

- **`DownloadManager`** — work queue, bounded concurrency (2),
  segment-granular pause/resume (completed segments stay on disk,
  interrupted segment re-fetched). Low-storage preflight before any
  authorization is minted (`getFreeDiskStorageAsync`, ~128 kbps estimate
  - 50 MiB headroom).
- **Package format** — HLS segments are downloaded and concatenated into
  one MPEG-TS file at
  `documentDirectory/offline/<trackId>/audio.ts` (app-private). Only
  complete, byte-verified downloads are marked playable.
- **`OfflineProvider`** — owns one manager per sign-in, runs crash
  recovery on mount (interrupted downloads land paused, never
  auto-resumed), starts the connectivity sync; unmount stops both.
- **`sync.ts`** — on startup when already online, and on every
  false→true connectivity transition: flush queued events, then
  revalidate authorizations. Never extends anything while offline.
- **Engine integration** — `PlaybackEngine` resolves an `OfflineSource`
  (local file + SecureStore authorization record) before minting any
  streaming session. Offline tracks get no playback session; offline
  START/HEARTBEAT/COMPLETE/ERROR events go to the durable AsyncStorage
  queue. One shared engine — queue, seek, repeat, shuffle, background,
  and Now Playing all behave the same.
- **Two-tier metadata** — authorization-critical records
  (authorizationId, trackId, pinned version, window, revocation) in
  SecureStore, written only from server responses; UI/download state in
  AsyncStorage. Editing display metadata cannot extend authorization.

## What still needs real devices

None of this has run on physical hardware in this phase (no device/SDK
in the sandbox):

- actual offline playback of the concatenated MPEG-TS package with
  expo-audio on Android and iOS (the package format is unproven),
- memory behavior while assembling long downloads (segments are held
  in memory during assembly),
- interrupted/background downloads, low-storage behavior, app relaunch,
- lock-screen and Now Playing behavior, account switching,
- authorization expiry/revocation while offline,
- `Crypto.randomUUID()` on target runtimes,
- CarPlay and Android Auto behavior (controllers are regression-tested
  against the shared engine; no head-unit/simulator pass yet).

No production-readiness claim is allowed without this evidence.
