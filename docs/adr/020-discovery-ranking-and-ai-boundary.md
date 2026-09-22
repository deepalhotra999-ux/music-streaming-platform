# ADR-020: Deterministic Versioned Ranking & the AI Provider Boundary

**Date:** 2026-09-22
**Status:** Accepted
**Phase:** 26

## Context

Phase 26 adds an AI-assisted music discovery and recommendation engine. The
core tension: recommendations must feel intelligent and personalized, but the
platform has hard guarantees to keep — catalog truth (never invent tracks,
artists, or availability), authorization boundaries (recommendations never
grant playback entitlement), privacy (no private listening history, identity,
credentials, or private playlist contents reach any AI), and auditability
(why was this track recommended?).

A naive integration — "ask the model for track IDs" — violates all of these:
models hallucinate IDs, leak prompt content, and cannot be versioned or
tested deterministically. This ADR records the architecture chosen to get
intelligence without surrendering those guarantees.

## Decision summary

1. **Deterministic first-party ranking is the product; AI is an optional
   interpretation layer.** The recommendation pipeline (signals → candidates
   → scoring → diversity → response) is pure, deterministic, and fully owned.
   AI converts natural-language intent into *structured constraints*
   (`DiscoveryConstraints`); it never selects tracks, never sees the catalog,
   and never sees the user.
2. **The AI provider boundary is a narrow, validated interface.**
   `RecommendationAIProvider.interpret()` receives only the raw query text
   plus non-identifying context (locale, result limit) and returns a
   constraints object. Output is validated, sanitized, and clamped
   server-side; invalid output triggers deterministic fallback, never an
   error to the user.
3. **Ranking is versioned and deterministic.** A `RecommendationPolicy`
   (weights, diversity caps, emerging-artist criteria, pool limits) is a
   plain serializable object with a version string (`v1`). Same input
   snapshot + same policy version ⇒ identical ordering. Policies are never
   mutated in place; changes create a new version.
4. **Every recommendation carries its reason.** Each item includes a
   human-readable reason derived from its candidate source and anchor
   entity (e.g. "Because you liked <artist>"). Reasons are factual claims
   about the user's own signals — never fabricated personalization.
5. **Cold start is honest.** Users without sufficient signals get popular /
   new-release / emerging content explicitly flagged `coldStart: true`.
   The system never invents a taste profile.
6. **Streams reuse Phase 15 semantics.** One COMPLETE play event per
   playback session = one stream. Emerging-artist aggregations count
   `COUNT(DISTINCT session_id)`, consistent with royalty analytics.

## 1. The provider boundary

```ts
interface RecommendationAIProvider {
  readonly name: string;
  interpret(input: AIInterpretInput): Promise<AIProviderResult>;
}
interface AIInterpretInput {
  query: string;        // raw user text, the ONLY user data the AI sees
  locale?: string;
  limit: number;
}
interface AIProviderResult {
  constraints: DiscoveryConstraints;  // validated server-side, never trusted
  providerName: string;
}
```

What the AI **never** receives: user ID, listening history, likes, follows,
playlists (even public ones), credentials, tokens, payment data, or any
catalog rows. The prompt carries instruction/data separation — the query is
data, never instructions — so prompt-injected queries ("ignore previous
instructions…") are treated as inert text.

What the AI **never** produces: track IDs, artist names as selections,
stream URLs, or availability claims. It produces only constraints:
genre IDs (re-resolved against the real genre table), mood hints, energy /
tempo / era hints, artist IDs (re-resolved against the real artist table),
an `emergingOnly` flag, a limit, and an exploration appetite.

**Validation is the boundary, not the provider's goodwill.**
`validateAIConstraints()` rejects non-objects, drops malformed IDs,
clamps out-of-range numbers, and sanitizes display text. A provider that
returns garbage (or throws, or times out) yields `constraints === null`,
and the service falls back to the deterministic keyword interpreter with
`policy.aiProvider = 'deterministic-fallback'`. The response always tells
the client which provider produced the constraints — no silent substitution.

Three providers ship:

- `DeterministicAIProvider` — local keyword parser, no network, no
  credentials. The default. Parses energy/mood/era/emerging intent from
  text with fixed rules.
- `MockAIProvider` — returns a canned constraints value verbatim for
  tests (no spread: spreading a non-object would defeat validation).
- `FailingAIProvider` — always throws, proving graceful fallback.

A future hosted-model provider implements the same interface; the boundary
does not change.

## 2. Deterministic ranking

Pipeline per request:

1. **Signals** (`signals.ts`): build a `SignalProfile` from the user's own
   first-party data — strong signals (likes, follows, playlist adds,
   COMPLETE plays) and weak signals (skips, partial plays, impressions).
   Only the requesting user's rows are read; private playlist contents of
   other users are never visible (authz layer).
2. **Candidates** (`candidates.ts`): bounded generators emit candidates
   from signal anchors — `recently_played_related`, `liked_artist`,
   `followed_artist`, `genre_affinity`, `popular`, `new_release`,
   `emerging`, `similar_artist`. Each generator is capped
   (`maxCandidatesPerGenerator`); the pool is capped
   (`maxCandidatePool`). Only READY, non-deleted, non-takedown tracks.
3. **Scoring** (`ranking.ts`): pure function of (candidate, profile,
   constraints, policy). Factor contributions (`artistAffinity`,
   `genreAffinity`, `recency`, `popularity`, `constraintMatch`,
   `emergingBoost`, `repetitionPenalty`) are recorded per item — testable,
   no black box.
4. **Diversity** (`ranking.ts`): hard caps `maxPerArtist` /
   `maxPerGenre`; an `explorationFraction` of slots is reserved for
   novelty, but exploration never violates the caps.
5. **Response** (`service.ts`): items carry stable IDs (real catalog rows
   only — verified by test), reasons, and a `PolicyInfo` block
   (`policyVersion`, `aiProvider`, `coldStart`).

Because scoring is pure and the policy is versioned, any recommendation
can be reproduced and audited: log the input snapshot + policy version.

## 3. Emerging artists

"Emerging" is defined by measurable criteria in `EmergingArtistPolicy`,
never by subjective judgment:

- artist created within `maxAgeDays`;
- recent-window vs previous-window stream growth ≥ `minGrowthRatio`
  (or no previous streams + enough recent streams);
- recent streams within [`minStreams`, `maxStreams`];
- lifetime streams ≤ `maxHistoricalStreams`.

Streams are `COUNT(DISTINCT session_id)` over COMPLETE `play_events` —
the same stream unit royalty analytics uses (Phase 15/21). The aggregation
is raw SQL (Prisma groupBy cannot traverse relations) with parameterized
UUIDs via `Prisma.join` + `Prisma.sql`.

## 4. What is explicitly NOT built

- No foundation-model training, no embeddings, no vector database.
- No social/collaborative filtering (no "users like you").
- No automatic persistent playlist creation — `playlist-criteria`
  returns criteria + candidates without mutating anything.
- No recommendation-specific playback tokens; playback uses ordinary
  Phase 7 sessions. Recommendations never grant entitlement.
- No catalog search changes; existing search is preserved untouched.

## 5. Caching and staleness

Recommendations are cached per user + policy version + constraints hash
with a short TTL. The cache is a performance layer, not a correctness
layer: signal changes (new like, new play) may take up to one TTL to
reflect. `refresh=true` bypasses the cache. Cache keys are user-scoped;
no cross-user leakage (tested).

## 6. Telemetry

Per-request telemetry records generator contribution counts, fallback
occurrences, and policy version — never query text, never user identity
beyond the already-authenticated request context. Used to monitor
fallback rate and generator health.

## Consequences

- Recommendations are explainable, reproducible, and testable (36
  backend tests, including prompt-injection, isolation, and
  no-fake-personalization coverage).
- Swapping or upgrading the AI provider cannot change ranking semantics,
  invent catalog entities, or bypass authorization — the boundary is
  structural, not prompt-based.
- Policy evolution is safe: new versions are additive; old versions
  remain identifiable in telemetry and responses.
