# Production Readiness Guide

This document describes what is required to run the Waveform music streaming
platform in production. It distinguishes what the codebase provides from what
the operator must supply.

**Status classification (see PHASE-32-REPORT.md): CONDITIONALLY PRODUCTION-READY.**
The code is hardened and tested; production operation requires the external
accounts, configuration, and manual verifications listed below.

---

## 1. Infrastructure (operator-supplied)

The `infra/` directory contains a placeholder README only. There is no AWS CDK
or Terraform implementation in this repository — this is a deliberate scope
decision for Phase 32 (the brief forbids inventing new product phases, and a
full IaC stack is a separate infrastructure project). The production topology
the application expects:

| Component | Requirement |
|-----------|-------------|
| Compute | Node 22+, 2+ instances behind a load balancer (rate limits are per-instance in-memory; see §5) |
| Database | PostgreSQL 16, managed (RDS/Cloud SQL). Run `prisma migrate deploy` on release. Backups + PITR required. |
| Object storage | S3-compatible bucket, **private** (block all public access). Audio served via session-scoped API routes, never permanent public URLs. |
| CDN | CloudFront (or equivalent) in front of HLS segment delivery for scale. Signed URLs optional; the API session-token model works without them. |
| Reverse proxy | ALB / CloudFront / nginx terminating TLS. Set `TRUST_PROXY=true` **only** here (see §4). |
| Secrets | Secrets manager (AWS Secrets Manager / Doppler / Vault). Never env files on disk. |
| Observability | The app emits structured JSON logs (with `x-request-id` correlation) and an in-memory `/v1/metrics` endpoint. **Production requires a metrics backend** — Prometheus scraping via an exporter, or a log-based metrics pipeline — because the counters are per-process and reset on restart. |

## 2. Required configuration

All values come from environment. The server **fails fast at startup** when
production-required values are missing or inconsistent:

| Variable | Required in prod | Notes |
|----------|------------------|-------|
| `NODE_ENV=production` | Yes | Enables production fail-fast paths |
| `DATABASE_URL` | Yes | Pooled connection string (PgBouncer recommended) |
| `JWT_ACCESS_SECRET` | Yes | 256-bit random, rotated via overlap window |
| `CORS_ORIGIN` | Yes (if web clients) | Comma-separated allowlist; unset = CORS disabled |
| `TRUST_PROXY` | Set `true` only behind a trusted proxy | Default `false`; enabling without a proxy allows IP spoofing |
| `COMMERCE_PAYMENT_PROVIDER=stripe` | If selling merch | Requires both Stripe secrets or boot fails |
| `STRIPE_SECRET_KEY` | With Stripe | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | With Stripe | `whsec_...`; 300s timestamp tolerance enforced |
| `APPLE_*` / `GOOGLE_*` | For store subscriptions | All-or-nothing per provider; unset = 503 on store routes |
| `S3_BUCKET`, `S3_REGION` | Yes | Private bucket; `AUDIO_STORAGE_DRIVER=s3` |

The mock payment provider **refuses to boot** outside `development`/`test`.
`DEV` subscription provider likewise fails closed.

## 3. External accounts & manual setup (not code)

- [ ] **Stripe account**: live keys, webhook endpoint registered
      (`/v1/commerce/webhooks/stripe`), signing secret stored. No real charge,
      webhook delivery, or refund has been exercised — do a live test charge +
      refund before launch.
- [ ] **Apple App Store**: bundle ID, shared secret / App Store Server API key,
      Sandbox testing of subscription purchase/renew/cancel flows.
- [ ] **Google Play**: service account, RTDN Pub/Sub topic + push subscription,
      license testing.
- [ ] **Music licensing**: mechanical + performance licenses for your catalog
      territory(s). **The platform has no license; operating without one is a
      legal blocker, not a technical one.**
- [ ] **Payout/tax infrastructure**: artist payouts (Stripe Connect or
      equivalent), tax forms (W-9/W-8BEN), royalty statement delivery.
- [ ] **Legal policies**: Terms of Service, Privacy Policy, DMCA agent
      designation, content policy, artist agreements.
- [ ] **Restore test**: restore the database backup to a scratch instance and
      run `prisma migrate deploy` + smoke tests. Untested backups are not backups.
- [ ] **DNS/TLS**: certificates, HSTS at the proxy (Helmet sets headers;
      HSTS preload is a proxy concern).

## 4. Security posture (implemented)

- Helmet security headers on all responses; CORS allowlist (default deny).
- Global 1 MiB JSON body limit; audio uploads stream with a separate
  100 MiB cap and magic-byte sniffing (client filenames/MIME never trusted).
- Per-route rate limits (auth endpoints strictest); per-IP.
- Argon2id passwords; HS256 access JWT (15 min) + rotating opaque refresh
  tokens (reuse = family revocation).
- IDOR/BOLA: ownership checks on playlists, artist catalog, royalties,
  commerce, rooms; private resources 404 to non-owners.
- Playback/download tokens: opaque, session-scoped, 15-min TTL, bound to
  user + track + entitlement; HLS URLs rewritten to session URLs (no ID/path leaks).
- Path traversal: schema patterns + `assertSafeKey` + root containment on
  local storage; S3 keys are server-generated.
- FFmpeg via `execFile` arg array (no shell); ffprobe validation before transcode.
- Webhooks: Stripe signature verification (300s tolerance), Apple/Google
  server-side verification, provider-event idempotency (replayed webhooks
  never double-apply).
- Admin audit log: append-only, DB trigger rejects UPDATE/DELETE.
- `/v1/metrics`: loopback or ADMIN-authenticated; remote unauthenticated
  callers get 404 (no existence leak).
- Secrets: never logged; error responses are RFC 7807 without internals.

## 5. Known limitations (do not ignore)

1. **Rate limits are in-memory per instance.** Behind N instances, effective
   limit is N× configured. Use a shared store (Redis) or sticky sessions
   before scaling horizontally.
2. **Metrics are in-memory per process.** They reset on restart and are not
   aggregated across instances. Wire a real metrics backend (see §1).
3. **Ingestion queue is single-instance.** Concurrent transcodes on multiple
   instances need a distributed queue (SQS/BullMQ).
4. **Expo Doctor: 20/21.** `expo-modules-core` is intentionally pinned
   directly (the CarPlay/Android Auto native modules import it and declare it
   as a peer dep). All SDK patch versions are current. This does not block
   release.
5. **Physical device testing not performed.** VoiceOver, TalkBack, Dynamic
   Type, reduced motion, CarPlay head units, Android Auto DHU/head units,
   background audio on real devices — all require hardware not available in
   this environment. Do not ship the mobile apps to stores without it.

## 6. Operational runbooks (minimum)

- **Deploy**: `prisma migrate deploy` → health check `/v1/ready` (real DB
  check) → route traffic. `/v1/health` is liveness-only.
- **Rollback**: migrations are forward-only; keep a tested down-migration
  plan per release or restore from backup.
- **Key rotation**: JWT secrets support overlap; Stripe webhook secrets can be
  rolled in the dashboard then updated.
- **Incident**: request IDs (`x-request-id`) correlate logs across the stack.
  Auth failures and rate-limit hits are counted in `/v1/metrics`.
- **Royalty runs**: idempotent by `runKey` (unique constraint); a second
  concurrent run blocks rather than double-paying. Statements are immutable
  once finalized.

## 7. Load test summary

Local sandbox, 10 users / 30s, mixed read workload: **275.9 req/s, 0% errors,
p99 < 27ms**. Full results and caveats in `docs/LOAD-TEST-RESULTS.md`.
These are not production capacity projections.
