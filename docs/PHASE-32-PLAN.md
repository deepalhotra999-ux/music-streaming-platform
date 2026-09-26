# Phase 32 Implementation Plan

Date: 2026-09-26
Status: Draft → executing

## Audit findings (what exists)

- **Config**: `services/api/src/config.ts` — strong fail-fast validation; DEV/mock
  adapters (dev subscriptions, mock payments) refuse to boot outside
  development/test. No gaps found in gating.
- **Infra**: `infra/` is a README only — no Terraform/CDK was ever built.
  docker-compose covers local dev. No GitHub Actions workflows exist.
- **Server**: structured JSON logs; per-route rate limits; WS maxPayload bounded;
  graceful shutdown; `/v1/health` (no DB check). Missing: CORS, security
  headers, trust proxy, request/correlation IDs, readiness probe, global body
  limit review.
- **Auth**: Argon2id, JWT access + rotating refresh, brute-force rate limits.
  Apple/Google subscription adapters are `notImplemented` stubs — real store
  verification requires external credentials (documented, not faked).
- **Commerce**: mock payment provider only; provider abstraction exists
  (`PaymentProvider` interface) and supports a Stripe adapter cleanly.
- **Known issues**: analytics UTC-day test — FIXED (timezone-dependent
  DATE_TRUNC; now explicit UTC). expo-modules-core doctor failure — accepted
  (peer dep for CarPlay/Android Auto native modules; builds green).

## Plan (code changes)

1. **HTTP hardening** (`http/app.ts`, `http/correlation.ts`):
   - Request ID generation + propagation (`x-request-id`), included in logs.
   - `GET /v1/ready` — DB connectivity probe (distinct from liveness).
   - CORS: configurable `CORS_ORIGIN`, deny-by-default.
   - Security headers via `@fastify/helmet` (check availability; else manual).
   - `trustProxy` configurable for ALB/CloudFront deployments.
   - Global JSON body limit (already per-route? verify) + malformed-JSON handling.
2. **Observability** (`http/metrics.ts` or similar):
   - In-memory counters: requests by route/status, auth failures, rate-limit
     hits, playback errors, webhook deliveries, download authorizations.
   - `GET /v1/metrics` (admin-gated or local-only) — no external dep.
   - Redaction audit: verify no tokens/secrets in logs.
3. **Stripe payment adapter** (`modules/commerce/payments/stripe.ts`):
   - Implement `PaymentProvider` with Stripe PaymentIntents + webhook signature
     verification (Stripe-Signature header, timestamp tolerance).
   - No card data touches the app; server confirms with Stripe API.
   - Idempotent webhook handling via existing event-dedup.
   - Wired via `COMMERCE_PAYMENT_PROVIDER=stripe`; requires `STRIPE_SECRET_KEY`
     + `STRIPE_WEBHOOK_SECRET`; fails fast without them. Mock remains dev/test only.
4. **Security regression tests** (`tests/security-*.test.ts`):
   - IDOR/BOLA: cross-user playlist, cart, order, subscription, royalty,
     room, community moderation access → 403/404.
   - Token abuse: expired/wrong-user/wrong-track playback + download tokens.
   - Webhook forgery: bad signature → 401/400, no state change.
5. **Load testing** (`services/api/load/`):
   - Reproducible k6-or-plain-node script hitting auth, catalog, search,
     playback sessions, HLS auth, events, checkout (mock), WS rooms.
   - Run locally; report actual numbers, label as local (not prod capacity).
6. **CI/CD** (`.github/workflows/ci.yml`):
   - TS, tests (backend/mobile/admin), lint, prettier check, builds,
     expo exports, secret scan (gitleaks or grep-based), migration dry-run.
   - No secrets in logs; env-gated.

## Plan (verification, no code)

- Royalty determinism: re-run royalty suite + idempotency checks; document
  business/legal payout dependencies (no payout provider exists).
- DB concurrency: review inventory/checkout/webhook/royalty paths (already
  guarded SQL per ADRs); verify migrations apply cleanly on fresh DB.
- A11y gate: full mobile/admin suites green (Phase 31 intact).
- CarPlay/AA: manual checklists only (no hardware).

## Plan (docs)

- `docs/PRODUCTION-READINESS.md` — per-section status (implemented / tested /
  requires-external / requires-hardware / business-decision / not-safe).
- `docs/LAUNCH-CHECKLIST.md` — ordered pre-launch steps incl. external setup.
- `docs/PHASE-32-REPORT.md` — final report with all 18 required items.
- Privacy/data inventory, backup/DR runbook, licensing notes → inside
  PRODUCTION-READINESS.md (no new legal claims).
- Manual validation matrix → LAUNCH-CHECKLIST.md appendix.

## Explicitly out of scope

- Building a full AWS CDK/Terraform stack (document required infra instead).
- Real Apple/Google store verification (no credentials; stubs stay, docs exact).
- Real artist payouts (no provider specified; documented dependency).
- Physical device/hardware validation (checklists only).
- New features of any kind.
