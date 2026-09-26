# Launch Checklist

Check off every item before public launch. Items marked **[CODE]** are
implemented and tested in this repository; **[OPS]** require operator action;
**[EXT]** require external accounts or third parties; **[LEGAL]** require
business/legal decisions.

## Pre-launch — infrastructure & config [OPS]

- [ ] Production PostgreSQL 16 provisioned; `prisma migrate deploy` run; PITR backups enabled
- [ ] S3 bucket created, public access blocked; `AUDIO_STORAGE_DRIVER=s3` configured
- [ ] TLS termination at reverse proxy; `TRUST_PROXY=true` set (only behind that proxy)
- [ ] `CORS_ORIGIN` allowlist set to production web origins (or left unset for native-only)
- [ ] All secrets in a secrets manager; no `.env` files on production hosts
- [ ] `NODE_ENV=production`; server boots clean (fail-fast validated in CI release workflow)
- [ ] `/v1/ready` returns `{"status":"ready"}` through the load balancer
- [ ] Metrics backend wired (Prometheus exporter or log pipeline) — in-memory counters alone are insufficient
- [ ] Shared rate-limit store (Redis) or sticky sessions if running >1 API instance
- [ ] Distributed ingestion queue if running >1 API instance (transcodes are single-instance)

## Pre-launch — payments & subscriptions [EXT]

- [ ] Stripe live keys installed; webhook endpoint registered; signing secret stored
- [ ] **Live test**: real $1 charge + webhook delivery + refund in production mode
- [ ] Apple App Store Server API key; Sandbox subscription purchase/renew/cancel tested
- [ ] Google Play service account; RTDN push endpoint verified with test notification
- [ ] Payout rails for artists (Stripe Connect or equivalent); tax form collection

## Pre-launch — content & legal [LEGAL]

- [ ] Music licensing secured for launch territories (mechanical + performance)
- [ ] Terms of Service, Privacy Policy published; DMCA agent designated
- [ ] Artist agreements signed; royalty statement format approved by counsel
- [ ] Content moderation policy and escalation path defined (community features are moderated)

## Pre-launch — verification [OPS]

- [ ] Database restore test: backup restored to scratch, migrations + smoke tests pass
- [ ] Physical device testing: iOS + Android — VoiceOver/TalkBack, Dynamic Type, reduced motion
- [ ] CarPlay head unit / Android Auto DHU validation (Phase 23/24 were simulator-only)
- [ ] Background audio + lock-screen controls on real devices
- [ ] Store review assets: screenshots, descriptions, privacy labels, data safety forms

## Launch day

- [ ] Deploy with migrations; verify `/v1/ready` before routing traffic
- [ ] Smoke test: register → browse → play → offline download → purchase (test SKU)
- [ ] Monitor `/v1/metrics` (via backend) for 5xx, auth failures, rate-limit hits
- [ ] Royalty dry-run on production play events; verify statement math before finalizing

## Post-launch (first 30 days)

- [ ] Rotate JWT access secret using the overlap window
- [ ] Review admin audit log weekly
- [ ] First real royalty run: reconcile against raw play_events before publishing statements
- [ ] Load-test findings re-validated against production metrics

---

## What is already done [CODE]

Backend 681 tests (incl. 26 Phase-32 security, 32 royalty, 29 analytics),
mobile 766, admin 48 — all passing. Security headers, CORS allowlist, body
limits, correlation IDs, readiness probe, gated metrics, Stripe provider
abstraction, atomic inventory, idempotent checkouts/webhooks/royalty runs,
append-only audit log, BigInt royalty math. See `docs/PHASE-32-REPORT.md`.
