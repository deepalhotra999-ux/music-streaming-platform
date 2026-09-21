# ARCHITECTURE.md — Music Streaming Platform

> Phase 0 deliverable. Technology recommendations, system structure, and service
> design. No application code. Decisions recorded here become ADRs in Phase 1.

## 1. Technology Stack Recommendations

### Mobile app — Native: Swift/SwiftUI (iOS), Kotlin/Jetpack Compose (Android)

- **Why native:** background audio, lock-screen/remote-command integration,
  CarPlay, and Android Auto all require deep platform integration. Cross-platform
  frameworks add a leaky abstraction exactly where this product lives (audio
  sessions, now-playing info, offline downloads).
- **Shared logic later:** Kotlin Multiplayer (KMP) can share networking/models
  in a later phase if duplication becomes painful — not for v1.
- **Minimum:** iOS 17+, Android 14+ (API 34).

### Backend — Go, modular monolith

- **Why Go:** single language across API and workers, excellent concurrency for
  ingestion/transcoding orchestration, small binaries, strong stdlib, boring and
  proven at streaming scale.
- **Shape:** one deployable "modular monolith" with strict internal module
  boundaries (`catalog`, `identity`, `library`, `billing`, `ingestion`,
  `streaming`). Extract to services only when a module earns it (team or scale
  pressure) — not before.
- **API style:** REST with OpenAPI contracts (`/v1/...`), versioned from day one.
- **Alternative considered:** TypeScript/NestJS if the founding team is
  TS-heavy. The architecture below is language-agnostic; pick one and commit.

### Database — PostgreSQL (primary) + Redis (cache/queues)

- **PostgreSQL 16+** as the system of record for all relational data (users,
  catalog, playlists, subscriptions). Chosen for correctness, JSONB
  flexibility, and full-text search that is good enough for v1.
- **Redis** for sessions/refresh-token denylist, rate limiting, job queues
  (or a dedicated queue — see below), and hot caches (browse rails, search
  suggestions).
- **Search path:** start with Postgres FTS; migrate to OpenSearch/Typesense
  when relevance tuning outgrows it. Do not operate a search cluster on day one.
- **Analytics/play events:** append-only table partitioned by month; aggregate
  offline. Do not let analytics writes contend with product reads.

### Authentication — Managed OIDC provider (e.g. Auth0)

- **Why managed:** passwords, MFA, breach detection, and social logins are not
  a differentiator. Use an OIDC provider; the backend validates JWTs and owns
  authorization.
- **Tokens:** short-lived access JWTs (5–15 min) + rotating refresh tokens.
  Sign in with Apple and Google are required for the mobile apps (Apple
  mandates Sign in with Apple if any third-party social login exists).
- **Authorization:** backend-owned RBAC/claims (`listener`, `artist`,
  `admin`) embedded in tokens or resolved per request; never trust client
  claims for entitlements.

### Audio streaming — HLS over CDN with signed URLs

- **Protocol:** HLS (HTTP Live Streaming). Effectively mandatory for reliable
  iOS background playback and CarPlay; also fine on Android via ExoPlayer.
- **Renditions:** AAC-LC at 128k and 256k (add 64k HE-AAC later for constrained
  networks). Segmented `.m3u8` + `.ts`/fMP4.
- **Delivery:** object storage origin → CDN (CloudFront or Cloudflare).
  Playback URLs are short-lived signed URLs; the API checks subscription
  entitlement before signing.
- **Uploads/transcoding:** artists upload FLAC/WAV/MP3 → async worker
  validates, loudness-normalizes, and transcodes with FFmpeg into renditions.

### Storage — S3-compatible object storage

- **What lives here:** upload originals (private), transcoded renditions
  (private, CDN origin), artwork (public via CDN).
- **Provider:** AWS S3 or Cloudflare R2 (R2 has zero egress fees — attractive
  for a streaming product). Choose one; keep the code provider-agnostic.
- **Hygiene:** lifecycle policies (move originals to cold storage after
  renditions verified), versioning on, no public buckets except artwork via CDN.

### Payments — App Store IAP + Google Play Billing + Stripe (web)

- **Mobile:** digital subscriptions **must** use Apple's IAP and Google Play
  Billing (platform policy — no way around it for in-app purchase).
- **Web:** Stripe for web sign-ups and artist payouts (Stripe Connect) later.
- **Source of truth:** a backend `entitlements` model fed by
  App Store Server Notifications, Google Play RTDN, and Stripe webhooks.
  Clients never decide premium status locally.

### CarPlay — Native CarPlay in the iOS app

- Implemented with `CPTemplateApplicationScene` / CarPlay framework inside the
  existing iOS target (no separate app).
- Requires Apple's **CarPlay audio app entitlement** — apply early, approval
  takes time and is a launch blocker.
- Templates: list/grid browse, tab bar, Now Playing with queue. Voice via Siri
  intents (`INPlayMediaIntent`) in a later iteration.

---

## 2. Folder Structure (monorepo)

```
/                           # repo root
├── apps/
│   ├── ios/                 # Swift/SwiftUI app (includes CarPlay scene)
│   │   ├── App/
│   │   ├── Features/        # Browse, Search, Library, Player, ArtistUpload
│   │   ├── CarPlay/         # CPTemplate scenes, Now Playing
│   │   └── Core/            # Networking, Auth, Playback engine, Models
│   └── android/             # Kotlin/Jetpack Compose app (+ Android Auto later)
│       ├── app/
│       ├── feature/         # per-feature modules
│       └── core/            # networking, auth, playback (ExoPlayer), models
├── services/
│   └── api/                 # Go modular monolith
│       ├── cmd/api/         # main entrypoint
│       └── internal/
│           ├── catalog/     # artists, albums, tracks
│           ├── identity/    # users, auth integration
│           ├── library/     # playlists, likes, follows
│           ├── billing/     # plans, subscriptions, entitlements, webhooks
│           ├── ingestion/   # uploads, validation, transcode orchestration
│           ├── streaming/   # signed URL issuance, playback sessions
│           ├── search/      # search API over Postgres FTS
│           └── platform/    # config, db, http, jobs, observability
├── workers/
│   └── transcoder/          # FFmpeg worker: validate → normalize → renditions
├── packages/
│   └── contracts/           # OpenAPI specs, shared event schemas
├── infra/                   # Terraform: DB, Redis, buckets, CDN, secrets
├── docs/
│   ├── adr/                 # Architecture Decision Records (from Phase 1)
│   ├── ARCHITECTURE.md      # this file
│   └── DATABASE.md          # data model
└── tools/
    └── seed/                # royalty-free placeholder audio/artwork generation
```

**Rules for the layout:**

- Mobile apps never talk to the database or object storage directly — all
  traffic goes through `services/api`, except CDN media fetches via signed URLs.
- `packages/contracts` is the only shared-code surface between apps and backend
  (OpenAPI first, generate clients).
- Feature modules in the apps own their UI + view models; `Core` owns
  networking, auth, and the playback engine.

---

## 3. Major Services (logical modules)

| Module      | Owns                                                                      | Notes                                               |
| ----------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| `identity`  | users, profiles, auth integration, RBAC claims                            | Delegates auth to OIDC provider; owns authorization |
| `catalog`   | artists, albums, tracks, artwork metadata                                 | Read-heavy; aggressively cached                     |
| `ingestion` | upload sessions, validation, transcode jobs                               | Async; artist-facing                                |
| `streaming` | playback sessions, signed URL issuance                                    | Checks entitlements per request                     |
| `search`    | full-text search, suggestions                                             | Postgres FTS v1                                     |
| `library`   | playlists, playlist items, likes, follows                                 | User data; never cached across users                |
| `billing`   | plans, subscriptions, entitlements, webhooks                              | Source of truth for premium status                  |
| `platform`  | config, DB access, HTTP plumbing, background jobs, logging/metrics/traces | No product logic                                    |

**Background workers:**

- `transcoder` — consumes transcode jobs: validate audio → loudness normalize →
  produce HLS renditions → verify → publish to catalog. Idempotent, retryable.
- Job queue: Redis-backed (or SQS if on AWS) — decided in Phase 1 ADR.

---

## 4. API Overview

- **Base:** `https://api.<domain>/v1/...`, REST + JSON, OpenAPI 3.1 published
  from `packages/contracts`.
- **Auth:** `Authorization: Bearer <access JWT>` on all endpoints except
  public catalog reads and auth callbacks. Refresh via `POST /v1/auth/refresh`.
- **Conventions:** cursor pagination (`?cursor=&limit=`), RFC 7807 problem
  responses, idempotency keys on `POST` mutations (uploads, playlist writes,
  purchases), rate limits per identity class.

**Endpoint groups (v1 sketch — contracts finalized per phase):**

| Group              | Examples                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Auth               | `POST /v1/auth/refresh`, `GET /v1/me`                                                        |
| Catalog            | `GET /v1/artists/{id}`, `GET /v1/albums/{id}`, `GET /v1/tracks/{id}`, `GET /v1/browse/rails` |
| Search             | `GET /v1/search?q=&type=`                                                                    |
| Library            | `GET/POST /v1/playlists`, `POST /v1/playlists/{id}/items`, `POST /v1/likes`                  |
| Streaming          | `POST /v1/playback/sessions` → returns signed HLS URL set; `POST /v1/playback/heartbeat`     |
| Ingestion (artist) | `POST /v1/uploads` (multipart session), `GET /v1/uploads/{id}/status`                        |
| Billing            | `GET /v1/plans`, `GET /v1/subscriptions/current`, webhook receivers (provider-signed)        |

**Webhooks (inbound):** App Store Server Notifications v2, Google Play RTDN,
Stripe events — all signature-verified, idempotent, and logged before
processing.

**What the API never does:** serve audio bytes directly (CDN does that),
decide premium status from client input, or expose internal job state beyond
the upload-status endpoint.

---

## 5. Key Non-Functional Decisions

- **Environments:** dev / staging / prod from Phase 1; staging mirrors prod
  topology (smaller instances).
- **Secrets:** managed secret store (AWS Secrets Manager / equivalent) —
  never in code, never in images.
- **Observability:** structured JSON logs, OpenTelemetry traces,
  RED metrics per endpoint, from the first deploy.
- **Data retention:** play events kept raw 13 months (royalty reporting),
  then aggregated. User deletion cascades per privacy policy.

## 6. Decisions (recorded in Phase 1)

- **ADR-001 — Backend language: TypeScript.** Phase 0 recommended Go; the
  project owner directed a TypeScript monorepo. The modular-monolith shape,
  REST/OpenAPI contracts, and service boundaries in §2–§4 are unchanged —
  only the implementation language moves. Revisit only if runtime or
  concurrency needs force it.
