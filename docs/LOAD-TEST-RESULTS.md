# Load Test Results — Phase 32

**Date:** 2026-09-26
**Environment:** Local sandbox (NOT production hardware)
**Tool:** `services/api/load/api-load.mjs` (reproducible, zero-dependency)

## Configuration

- 10 concurrent users, 30 second duration
- Rate limits raised via env for synthetic test (RATE_LIMIT_API=10000, etc.)
- Production defaults are 300 req/min/IP (verified working — the first test run
  hit 429s at 306 req/s, confirming the limiter functions correctly)

## Results

| Endpoint | Requests | Errors | p50 | p95 | p99 |
|----------|----------|--------|-----|-----|-----|
| GET /v1/discovery/recommendations | 2,067 | 0 | 2.6ms | 7.4ms | 17.8ms |
| GET /v1/me | 2,067 | 0 | 4.1ms | 12.4ms | 25.0ms |
| GET /v1/tracks (list + q-search) | 4,134 | 0 | 4.2ms | 12.2ms | 26.1ms |
| POST /v1/auth/register+login | 10 | 0 | 45.5ms | 118.8ms | 118.8ms |

**Total:** 8,278 requests in ~30s = **275.9 req/s, 0.00% error rate**

## Honest caveats

1. **These are NOT production capacity numbers.** The sandbox is a shared VM
   with unknown CPU/memory contention. Production hardware, database tuning,
   connection pooling, CDN, and horizontal scaling will differ materially.
2. **No streaming load tested.** HLS segment delivery (the bandwidth-heavy
   path) was not exercised — that requires audio fixtures and sustained
   connections, and production streaming goes through S3/CloudFront, not the
   API server.
3. **No write-heavy load tested.** The workload was read-dominant (catalog,
   search, recommendations, auth checks). Checkout, playlist mutation, and
   royalty run concurrency under load are covered by transaction/idempotency
   unit tests, not by this load test.
4. **Single instance.** No horizontal scaling, no Redis (rate limits are
   in-memory per instance — see PRODUCTION-READINESS.md).

## What this proves

- The API sustains ~276 req/s of mixed read workload on modest hardware
  with zero errors and p99 < 30ms.
- The per-IP rate limiter correctly 429s abusive traffic (verified in the
  first run before limits were raised for the synthetic test).
- Auth (Argon2id) adds ~45ms p50 per login — acceptable for session setup,
  not on the hot path (JWT verification is ~4ms p50 on /v1/me).
