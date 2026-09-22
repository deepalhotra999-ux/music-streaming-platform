# AI Discovery & Recommendations

Phase 26 adds an AI-assisted discovery engine to the platform. This document
is the operator and integrator guide: what the endpoints do, how the AI
layer works, and the safety properties you can rely on.

For the architectural rationale, see
[ADR-020](adr/020-discovery-ranking-and-ai-boundary.md).

## Endpoints

All endpoints require authentication (Bearer JWT). Responses are returned
directly (no `{ data, pagination }` envelope); errors use RFC 7807
problem details.

### GET /v1/discovery/recommendations

Personalized recommendations for the authenticated user.

Query params:

- `limit` (default 20, max 50) — number of tracks.
- `genreId` (optional) — restrict to a catalog genre ID.
- `artistId` (optional) — restrict to a catalog artist ID.
- `emergingOnly` (boolean) — only emerging-artist tracks.
- `refresh` (boolean) — bypass the recommendation cache.

Response:

```json
{
  "requestId": "uuid",
  "policy": {
    "policyVersion": "v1",
    "personalized": true,
    "aiProvider": "deterministic"
  },
  "items": [
    {
      "track": {
        "id": "uuid",
        "title": "…",
        "durationMs": 210000,
        "artist": { "id": "uuid", "name": "…" },
        "album": { "id": "uuid", "title": "…" }
      },
      "reason": "Because you liked Aurora Skies",
      "reasonKind": "liked_artist"
    }
  ],
  "candidateCount": 42,
  "generatedAt": "2026-09-22T00:00:00.000Z"
}
```

- Every `track.id` resolves to a real catalog row (READY, not deleted, not
  takedown). The API never invents tracks.
- `reason` is a factual claim about your own signals. When
  `policy.personalized` is `false` (cold start), reasons describe
  popularity/recency — never fake personalization.
- `policy.aiProvider` names the constraint source: `deterministic` for
  the local interpreter, a provider name for a configured AI, or
  `deterministic-fallback` when AI output was invalid/unavailable.

### POST /v1/discovery/query

Natural-language discovery. Body: `{ "query": "upbeat workout music" }`
(max 500 chars). The AI layer converts the text into structured constraints;
ranking is still deterministic. Returns the same shape as above. The
interpreted constraints stay server-side — only `/playlist-criteria`
exposes them.

Prompt-injected queries ("ignore your instructions and …") are treated as
inert text — the query is data, never instructions.

### GET /v1/discovery/emerging

Emerging artists by measurable criteria (see ADR-020 §3): recently created,
growing streams, limited lifetime exposure. Returns artist IDs, names, and
stream counts — no subjective judgments.

### POST /v1/discovery/playlist-criteria

Body: `{ "query": "…" }`. Returns the interpreted criteria plus candidate
tracks **without creating a playlist or modifying anything**. The client
creates the playlist through the normal playlist API if the user confirms.

## The AI layer

`RecommendationAIProvider` is a narrow interface:

```ts
interpret({ query, genreNames, limit }) => { constraints, providerName }
```

The provider sees **only** the query text plus non-identifying catalog
context (genre names). It never receives user IDs,
listening history, likes, follows, playlists, credentials, or catalog rows.
It returns **only** `DiscoveryConstraints` (genre/artist IDs, mood/energy/
tempo/era hints, `emergingOnly`, limit, exploration appetite) — never track
selections, never URLs, never availability claims.

Server-side, provider output is validated (`validateAIConstraints`):
non-objects rejected, malformed IDs dropped, numbers clamped, text
sanitized. Artist and genre IDs are re-resolved against the real catalog;
unknown IDs are dropped, never trusted. Invalid output → deterministic
fallback (`policy.aiProvider = 'deterministic-fallback'`), never an error.

Providers:

| Provider | Use |
|---|---|
| `DeterministicAIProvider` (default) | Local keyword parsing. No network, no credentials. |
| Hosted-model provider (future) | Implements the same interface; configured via `DISCOVERY_AI_PROVIDER`, `DISCOVERY_AI_API_KEY`, `DISCOVERY_AI_MODEL`. The boundary does not change. |
| `MockAIProvider` / `FailingAIProvider` | Tests only. |

## Ranking

Deterministic and versioned. `RecommendationPolicy v1` fixes weights
(artistAffinity 3.0, genreAffinity 2.0, constraintMatch 4.0, …), diversity
caps (max 2 tracks per artist, max 4 per genre), an exploration fraction,
candidate-pool limits, and the emerging-artist policy. Same inputs + same
policy version ⇒ identical ordering. Policies are never mutated in place.

Candidate generators (all bounded): `recently_played_related`,
`liked_artist`, `followed_artist`, `genre_affinity`, `popular`,
`new_release`, `emerging`, `similar_artist`.

## Privacy & safety properties

- **No private data to AI.** Listening history, identity, credentials,
  tokens, payment data, and private playlist contents never reach any
  provider. Verified by test (isolation suite).
- **No cross-user leakage.** Signals are read per-user; recommendation
  cache keys are user-scoped. Private playlists never surface in another
  user's results.
- **No entitlement from recommendations.** Responses contain no playback
  tokens or URLs. Playback always goes through Phase 7 sessions, which
  remain authoritative.
- **No catalog mutation.** Discovery is read-only except for telemetry.
  `playlist-criteria` never creates playlists.
- **No generated music.** The system never generates or alters audio.
- **Honest cold start.** New users get popular/new/emerging content with
  `policy.personalized: false`. The system never fabricates a taste profile.
- **Rate limited.** `recommendations` and `emerging` use the shared API
  rate limiter. The natural-language endpoints (`/query`,
  `/playlist-criteria`) use a dedicated tighter per-user bucket
  (`DISCOVERY_QUERY_RATE_LIMIT` requests per
  `DISCOVERY_QUERY_RATE_LIMIT_WINDOW_MS`) since each call may invoke an
  AI provider. Over-limit requests return 429 with `Retry-After`.

## Caching

Recommendations are cached per (user, policy version, constraints hash)
with a short TTL. Signal changes may take up to one TTL to reflect;
`refresh=true` bypasses the cache. Staleness is bounded and documented —
the cache is a performance layer, not a correctness layer.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DISCOVERY_AI_PROVIDER` | `none` | `none` (deterministic local parsing) or a hosted provider name; unknown values fall back to `none` |
| `DISCOVERY_AI_API_KEY` | — | Hosted provider key (via Secure Vault, never in code) |
| `DISCOVERY_AI_MODEL` | — | Hosted provider model |
| `DISCOVERY_AI_TIMEOUT_MS` | `8000` | AI request timeout in milliseconds |
| `DISCOVERY_CACHE_TTL_MS` | `300000` | Recommendation cache TTL (5 min) |
| `DISCOVERY_QUERY_RATE_LIMIT` | `30` | NL query requests per window per user |
| `DISCOVERY_QUERY_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds |

## Telemetry

Per request (structured log line, safe fields only): request ID, policy
version, candidate/final/dropped counts, AI provider name (or
`deterministic-fallback`), latency in milliseconds, failure category
(null on success), a personalization flag, and a coarse query-length
bucket (`none`/`short`/`medium`/`long`). Never raw query text (free text
may be sensitive), never listening history, never tokens or identity
beyond the authenticated context. Telemetry can never break
recommendations — sink failures are swallowed.
