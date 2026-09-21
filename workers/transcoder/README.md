# workers/transcoder

Background worker: validate uploads → loudness-normalize → transcode to HLS
renditions (FFmpeg) → verify → publish. **No code yet — arrives in Phase 4.**

Must be idempotent and retryable (see `docs/ARCHITECTURE.md`).
