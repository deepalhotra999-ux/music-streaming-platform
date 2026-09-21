# 006. Streaming: HLS behind short-lived playback sessions

Date: 2026-09-21
Status: accepted

## Context

Phase 7 builds the development streaming foundation: the API must serve audio
for playback without ever exposing permanent public audio URLs, with a
storage abstraction that lets AWS S3 + CloudFront replace the local disk
later, and with stream telemetry that can feed royalty reporting and fraud
detection in later phases. Subscriptions, signed URLs, DRM, and offline
playback are explicitly out of scope.

## Decision

**HLS (VOD playlists, AAC-LC in MPEG-TS)** as the streaming protocol, per
ARCHITECTURE.md §1. One rendition (`128k`) in development; the key layout and
master-playlist builder already accommodate more renditions.

**Playback sessions gate every audio byte.** `POST /v1/playback/sessions`
(authenticated) checks track availability (exists, not deleted, `READY`),
runs the entitlement check, verifies audio assets exist, and issues an opaque
32-byte token (SHA-256 hash stored, raw token shown once — the Phase 3
refresh-token pattern). Token TTL defaults to 15 minutes. Manifest and
segment routes take the token as a query param (players fetch segments without
custom headers — the same reason signed URLs use query params) and re-validate
it on every request. Invalid and expired tokens are indistinguishable (401).

**No permanent public audio URLs.** Served playlists are rewritten at serve
time: every asset URI becomes a session-scoped API URL with the token
attached. The storage directory is never exposed statically, and served
responses carry no track ids or filesystem paths.

**Storage abstraction** (`AudioStorage` interface): `stat` / `getObject`
(range-aware) / `exists`, with a key scheme
`tracks/<trackId>/hls/...` that is provider-agnostic. The local-filesystem
driver ships now; `AUDIO_STORAGE_DRIVER=s3` fails fast at startup until the
S3 + CloudFront provider (with `createSignedUrl`) is implemented. Key
validation rejects path traversal at the storage boundary, independent of
route-param validation.

**Play events are append-only telemetry** (`play_events`: START / HEARTBEAT /
COMPLETE / ERROR, with `positionMs`), recorded via
`POST /v1/playback/sessions/:id/events` against sessions the caller owns.
Kept separate from user-facing `listening_history`, per ARCHITECTURE.md's
"append-only table" guidance. Partition by month when volume demands it.

**Entitlement is a placeholder with a real enforcement point.**
`checkPlaybackEntitlement()` allows all playback in development; the route
already denies with 403 when it returns `allowed: false`. Phase 8 replaces the
function body with a subscription/entitlement lookup — no route changes.

**Seek** via HTTP Range on segments (206 + `Content-Range`, 416 when
unsatisfiable, `Accept-Ranges: bytes`). Manifests are `no-store`;
segments are immutable (`max-age=31536000, immutable`).

**Dev audio** is synthesized locally (`scripts/generate-dev-audio.ts`,
ffmpeg `sine` source, distinct frequency per track) — never copyrighted
material. Generated packages live under `services/api/storage/` (gitignored);
the seed catalog's 6 READY tracks each get a 30s HLS package.

## Consequences

- Adding a rendition = generate the package + list it in the master builder;
  no route changes.
- S3 + CloudFront = implement `AudioStorage` (+ `createSignedUrl`), flip
  `AUDIO_STORAGE_DRIVER`; session and event flows are untouched.
- Expired sessions accumulate until a janitor is added (noted as a known
  issue; the `expires_at` index exists for it).
- Token-in-URL appears in access logs; acceptable for development — production
  moves to CloudFront signed URLs with the same query-param shape.
