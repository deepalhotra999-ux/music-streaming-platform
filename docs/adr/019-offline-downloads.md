# ADR-019: Offline Downloads & Offline Playback

**Date:** 2026-09-22
**Status:** Accepted
**Phase:** 25

## Context

Phase 25 adds offline downloads and offline playback. The constraints are
unusual: the system must let a paying user keep playable audio on-device for
weeks without network, while (a) never exposing permanent public audio URLs,
(b) never trusting client-side entitlement state, (c) keeping downloads
revocable, and (d) integrating with the one existing `PlaybackEngine` rather
than building a second player. This ADR records the security boundary and
the mechanisms chosen — and is explicit about what is _not_ protected.

## Decision summary

1. **Download authorization is a new server-minted grant**, distinct from
   playback sessions. One database row per (user, track) — unique on
   `(userId, trackId)` — carries a short-lived _delivery token_ (for
   fetching segments) and a long-lived _offline entitlement window_
   (for offline playback). The row pins the track's audio version at
   issue; a version mismatch marks the download stale.
2. **Downloadable representation**: the existing HLS rendition segments,
   concatenated client-side into a single MPEG-TS file in app-private
   storage. Source audio is never exposed; no new server packaging pipeline.
3. **Track audio versioning**: `Track.audioVersion` (integer, default 1),
   bumped on successful re-ingestion. Authorizations pin the version;
   mismatch → stale, re-download required.
4. **Offline entitlement window: 30 days**, sliding — extended
   server-side on successful revalidation while entitled. Never extended
   while offline.
5. **Local storage**: app-private `documentDirectory/offline/<trackId>/`,
   no credentials alongside media, no custom media encryption. The honest
   boundary is the OS app sandbox (+ iOS Data Protection); this is not DRM.
6. **Offline play events**: queued locally with client UUIDs and true
   `occurredAt` timestamps, uploaded idempotently; the server validates
   ownership, authorization-window containment, revocation, track match,
   duration bounds, and per-session sequence plausibility (one
   authorization/track per session key, single START/COMPLETE, no
   heartbeat before START or after COMPLETE; backward seeks allowed —
   Phase 15 listening-time math clamps deltas to [0, 35s] so position
   games cannot inflate royalties). Accepted events append to the same
   `play_events` table as online events, attached to a synthetic
   server-side `PlaybackSession` per `offlineSessionKey`
   (`tokenHash = null`, never usable for streaming), so `sessionId`
   stays non-null and Phase 15 session/stream/royalty analytics work
   unchanged. Royalty calculation stays server-side.
7. **Engine integration**: a framework-free `OfflineSource` resolved by
   `offlineSource.ts` and injected into `PlaybackEngine` as
   `OfflinePlaybackHooks`. CarPlay and Android Auto inherit offline
   playback with no architectural changes — they drive the same engine.

## 1. Download authorization model

New table `offline_download_authorizations`:

- `id` (uuid), `userId`, `trackId`, `audioVersion` (int, pinned at issue)
- `tokenHash` — SHA-256 of an opaque 32-byte delivery token, shown once
  (same pattern as playback sessions / refresh tokens)
- `downloadTokenExpiresAt` — short delivery window (60 minutes). Only
  this token may fetch segments from the download delivery routes.
- `issuedAt`, `expiresAt` — the offline entitlement window (30 days).
- `revokedAt` (nullable), `lastValidatedAt` (nullable)

`POST /v1/offline/downloads/authorize { trackId }` (authenticated,
tightly rate-limited) runs the same gates as session creation — track
exists, not deleted, `READY` (TAKEDOWN → 409), active entitlement via
`checkPlaybackEntitlement` (403 otherwise) — and returns
`{ authorizationId, token, downloadTokenExpiresAt, expiresAt,
audioVersion, track: <minimal>, downloadUrl }`. The token is embedded
only in the returned `downloadUrl` (shown once, hash stored); no
storage keys, no permanent URLs, no credentials.

**Idempotent issuance:** one live row per (user, track) — a unique
constraint on `(userId, trackId)`. If a live (non-expired, non-revoked,
current version) authorization already exists, the endpoint rotates the
delivery token on the same row _without extending the entitlement
window_ — only revalidation extends it, and only while the user stays
entitled. A stale row (expired, revoked, or old version) is updated in
place, restarting the full window and clearing prior revocation. This
prevents authorization-row spam from repeated taps.

The delivery token authorizes only the token-scoped download routes
(`GET /v1/offline/downloads/hls/master.m3u8?token=`,
`.../:rendition/index.m3u8?token=`, `.../:rendition/:segment?token=`),
which re-validate the token and the track's _current_ streamability on
every request (a TAKEDOWN mid-download fails the remaining fetches).
Playback-session tokens do not work here and download tokens do not work
on playback routes — the grants are in different tables by design.

## 2. Downloadable representation

The client downloads the master playlist (to enumerate renditions),
takes the first rendition listed (a single 128k rendition in the current
pipeline — this bounds storage cost), downloads every segment, and
concatenates them into one file. MPEG-TS segments from a single rendition
share encoding parameters, so concatenation is byte-safe, and the result
plays directly from a `file://` URI in expo-audio on both platforms — no
local-HLS playlist quirks, no extra native code.

**Honest limitation:** the concatenated-TS package is unproven on real
devices in this phase (no device/SDK in the sandbox) and assembles
segments in memory. Before production, either prove it with expo-audio
on physical Android/iOS or switch behind the same source-resolver
abstraction to a local HLS package.

Deliberately not built: server-side packaging (zip/tar) or a new
rendition pipeline. The existing HLS packages are the single source of
audio truth; the download routes reuse `rewritePlaylistUris` and the
`AudioStorage` key scheme.

## 3. Track audio versioning

`Track.audioVersion INTEGER DEFAULT 1`, bumped (increment) on every
successful ingestion completion where audio was already READY — i.e. a
genuine replacement, not first publish. The authorization pins the
version; revalidation compares it against the live track row. Mismatch
marks the local download stale (`EXPIRED`-equivalent); the app must
re-authorize and re-download. We never silently play an outdated version
indefinitely — staleness is detected at the latest on the next
revalidation, and immediately on any online playback attempt.

## 4. Offline entitlement / revalidation policy

- **Window: 30 days** from `issuedAt`, a conventional offline-license
  duration. `expiresAt` is stored server-side and returned to the client.
- **While online**, the app revalidates each local authorization
  (`POST /v1/offline/downloads/:id/revalidate`, owner-scoped, others'
  ids → 404). On success _and continued entitlement_, the server extends
  `expiresAt` to now + 30 days (sliding window) and updates
  `lastValidatedAt`. The client may never extend the window itself.
- **While offline**, playback is allowed iff the local record is
  COMPLETED, the file is intact, `now < expiresAt`, not revoked, and the
  pinned version matches. Once expired offline, the engine refuses with
  the existing `locked` semantics and requires network revalidation.
- **Subscription state changes** (fail-closed, per Phase 18):
  - ACTIVE / TRIALING (valid) → playable; revalidation extends.
  - PAST_DUE → deny new authorizations; revalidation revokes existing
    local authorizations (no grace window, as decided in ADR-014).
  - CANCELED → deny new authorizations; existing authorizations keep
    their current window, then expire naturally.
  - EXPIRED → deny new authorizations; offline playback denied once the
    window lapses.
  - REVOKED → deny new authorizations; revalidation marks local records
    revoked immediately.
- Media is never deleted merely because the device is offline.

## 5. Local storage security boundary

- iOS and Android: `${documentDirectory}/offline/<trackId>/audio.ts`.
  `documentDirectory` is app-private on both platforms; nothing is
  written to public media directories or the system music library, and
  `file://` paths never leave the offline module.
- No tokens, keys, or credentials are stored alongside media. The
  delivery token is kept in memory only for the download and discarded.
- **Two-tier local metadata.** Authorization-critical records
  (authorizationId, trackId, pinned audioVersion, issuedAt/expiresAt,
  revokedAt) live in SecureStore — they, and only they, gate offline
  playback, and they are written only from server responses (authorize /
  revalidate), never from user input. Editing AsyncStorage display
  metadata therefore cannot extend authorization. UI/download state
  (status, progress, bytes) lives in AsyncStorage.
- **No custom media encryption.** Building our own crypto subsystem
  would be weaker, not stronger, than the platform boundary. The
  protection is: OS app sandbox + iOS Data Protection on the app
  container + no public URLs + server-side revocation/expiry. **Honest
  limitation: on a rooted/jailbroken device, or via a backup of an
  unlocked device, the concatenated audio file is extractable.** This is
  obfuscation-plus-entitlement, not DRM, and must never be described as
  DRM.

## 6. Offline play events

While playing offline media, the engine routes START/HEARTBEAT/COMPLETE/
ERROR into a local AsyncStorage queue instead of `reportPlayEvent`.
Each event carries a client-generated UUID (`offlineEventKey`), the
`offlineAuthorizationId`, an `offlineSessionKey` (one per offline
playback session, for stream grouping), the true `occurredAt` timestamp,
and position. On connectivity, the queue flushes to
`POST /v1/playback/offline-events` (max 500/batch), which validates
every event and appends accepted ones to the same append-only
`play_events` table as online events — attached to a synthetic
server-side `PlaybackSession` created per `(userId, offlineSessionKey)`
with `tokenHash = null` (never usable as a streaming delivery session).
`PlayEvent.sessionId` stays non-null; `createdAt` is set from
`occurredAt` so analytics bucket actual playback time, not upload time.
Phase 15 session/stream/royalty semantics apply unchanged: a stream is
a session with ≥1 COMPLETE, unique listeners are distinct session
userIds, and listening time clamps consecutive position deltas to
[0, 35s].

Per-event validation (fail-closed; unknown/other-user authorizations
read as "not found"):

- key present (≤64 chars), type in START/HEARTBEAT/COMPLETE/ERROR,
  positionMs integer ≥ 0 when present, valid `occurredAt`, not more
  than 5 minutes in the future (clock-skew tolerance),
- `occurredAt` inside the authorization's `[issuedAt, expiresAt]`
  window and not past `revokedAt`,
- authorization's track still exists; position ≤
  `durationMs + 30s` (reporting tolerance),
- one authorization (and therefore one track) per `offlineSessionKey`;
  a reused key across tracks/authorizations is rejected,
- sequence per session, validated in `occurredAt` order (wire order is
  deliberately ignored — idempotent retries and split batches may
  arrive shuffled): at most one START and one COMPLETE; COMPLETE and
  HEARTBEAT require a START; no HEARTBEAT after COMPLETE; events older
  than already-stored events for the session are rejected,
- backward seeks are allowed (seeks generate no events; a forward-jump
  time gate would false-reject legitimate seek-then-finish flows).
  Royalty safety does not rest on monotonicity — the 35s listening-time
  clamp makes position games unprofitable in either direction.

Idempotency: a unique constraint on `offlineEventKey` makes uploads
idempotent — replayed keys (across batches, within one batch, or from a
concurrent upload racing the insert, narrowed to the P2002
unique-violation) are reported accepted without new rows. Other DB
failures are rethrown, never silently counted as accepted.

**Honest limitation:** the server verifies that an event _could_ have
happened (right user, right track, inside the grant window, plausible
sequence), not that playback physically occurred — and offline playback
cannot be cryptographically proven without DRM/device attestation.
Royalty/stream calculations stay server-side and unchanged.

## 7. Download manager

`DownloadManager` (mobile, `src/offline/`): a work queue with bounded
concurrency (2 simultaneous downloads), progress callbacks, per-track
dedupe. Pause/resume is segment-granular and genuine: completed segments
stay on disk, an interrupted segment is re-fetched, and resume continues
from the first missing segment (`resumeSegment` in the record). Cancel, retry, remove
supported. Metadata lives in AsyncStorage (small JSON); audio bytes
never touch AsyncStorage. Crash safety: on boot, records stuck in
transient states are reconciled against file presence — an incomplete
download is never reported as COMPLETED/playable. Low storage is
checked up front (`getFreeDiskStorageAsync`, ~128 kbps estimate + 50
MiB headroom): no authorization is minted for a download that cannot
fit. Connectivity: NetInfo drives sync — the first state on startup
triggers a flush when already online, and false→true transitions flush
on regained connectivity.

## 8. What CarPlay / Android Auto need

Nothing architectural. Both integrations call `engine.setQueue()` on the
shared engine; the offline branch lives inside `loadTrackAt`, so a
downloaded track plays in the car exactly like a streamed one, including
queue/shuffle/repeat/Now Playing. Content browse still requires network
(the providers fetch from the API), which is documented as a limitation;
playback of an already-queued downloaded track works fully offline.

## Alternatives considered

- **Server-packaged single-file downloads (zip):** rejected — a second
  packaging pipeline and a second delivery format for no playback gain;
  TS concatenation achieves the same with existing assets.
- **Long-lived download tokens (no separate entitlement window):**
  rejected — a leaked token would grant indefinite segment access;
  splitting delivery (60 min) from entitlement (30 days) bounds both.
- **Encrypted media with keys in secure storage:** rejected for Phase
  25 — without platform DRM (Widevine/FairPlay, which would be a
  different product decision), software AES would only slow casual
  extraction while adding key-management risk. Documented as future work
  if a real DRM requirement arrives.
- **Permanent offline entitlement:** rejected — violates the brief's
  explicit "do not invent a permanent offline entitlement".
