# 010. Artist audio ingestion pipeline

Date: 2026-09-21
Status: accepted

## Context

Phase 14 gives ARTIST users a way to upload source audio for the tracks
they own and have the server transcode it into the Phase 7 HLS layout so
the existing playback engine can stream it. Requirements that shaped the
design:

- Uploads must never unpublish a track: re-processing a published track
  must keep the old HLS package serving until the new one is validated,
  and a failed re-processing must leave the catalog status untouched.
- The client filename, MIME type, and any aggregate numbers must never be
  trusted; validation is server-side (magic bytes + ffprobe).
- Storage must work locally in development and against a private S3
  bucket in production, with identical key semantics.
- Processing is CPU-bound (ffmpeg) and must not thrash the API box.
- Deployments run a single API instance today, but the claim mechanism
  should not assume that forever.

## Decision

1. **Separate ingestion lifecycle.** `tracks` gains `audio_status`
   (`NONE → PENDING → PROCESSING → READY | FAILED`), `audio_error`,
   `audio_source_key`, `audio_ready_at`. This is independent of the
   catalog `TrackStatus`, so ingestion can never unpublish a track.
   Manual `READY` on track create/update is rejected (422) — ingestion
   is the sole authority that grants `READY`.

2. **Private source, staged package, ordered promotion.** Uploads are
   stored under a server-generated key
   `tracks/<id>/source/<uuid>.<ext>` (never served to clients).
   ffmpeg transcodes to HLS in a temp dir, uploads to
   `tracks/<id>/hls-staging/...`, and the staged package is validated
   *from storage* (master parses, every rendition ends with
   `#EXT-X-ENDLIST`, every referenced segment exists and is non-empty)
   before promotion copies objects to the playable `hls/` layout in
   dependency order: segments → rendition playlists → master last.
   Promotion is ordered but not a multi-object atomic transaction.

3. **Idempotent worker claim.** `PENDING → PROCESSING` is a single
   conditional `UPDATE`; exactly one worker proceeds, retries are
   `FAILED → PENDING → PROCESSING`. Jobs run on a sequential in-process
   promise-chain queue (deduped per track, failure-isolated).

4. **Crash recovery on startup.** Tracks left in `PROCESSING` are reset
   to `PENDING` and re-enqueued, because the in-process queue does not
   survive a restart. Documented as single-instance-only: a horizontally
   scaled deployment must replace the blanket sweep with a distributed
   queue (advisory locks / job table with heartbeats).

5. **S3 driver behind the existing `AudioStorage` interface.**
   `AUDIO_STORAGE_DRIVER=s3` uses the standard AWS credential chain
   against a private bucket (`S3_BUCKET`, optional `S3_PREFIX`,
   `S3_REGION`); the local driver remains the default. `CopySource` is
   URL-encoded per path segment. Promotion ordering is the same on both
   drivers.

6. **Best-effort cleanup, never at the cost of correctness.** If storing
   the source succeeds but the DB update fails, the new source blob is
   rolled back; a superseded previous source is deleted best-effort
   (failure does not fail the upload). Stale HLS segments unreachable
   from promoted playlists may remain in storage (there is no
   list-prefix operation); they are never served.

## Consequences

- Artists get upload → processing → ready/failed with retry, visible in
  the mobile Artist tracks screen; players keep working through
  re-processing.
- Real AWS credentials/bucket were not exercised: S3 behavior is covered
  by mocked-SDK tests only; production rollout needs a bucket +
  CloudFront verification pass.
- The queue and recovery sweep assume one API instance; scaling out
  requires queue work first.
- Storage has no list-prefix, so orphaned unreachable objects can
  accumulate; a lifecycle/GC pass is future work.
