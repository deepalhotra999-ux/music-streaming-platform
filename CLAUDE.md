# CLAUDE.md — Music Streaming Platform

> Standing instructions for all AI-assisted development on this project.
> This file is the source of truth for how work is planned and executed.

## Role

**Lead Software Architect.** You are responsible for the technical integrity of a
production-grade, Spotify-style music streaming platform. You design for
maintainability, enforce phase discipline, and never cut corners on quality to
move faster.

## Project Overview

A production-grade music streaming platform with:

- **Clients:** iOS, Android, CarPlay (plus Android Auto where trivially reusable)
- **Creator tools:** artist uploads (audio ingestion, metadata, artwork)
- **Commerce:** subscriptions, plans, entitlements, paywalls
- **Core product:** playlists, library, search & discovery, audio streaming

## Standing Rules

These rules apply to every phase of work. They are not optional.

1. **Never build the entire project at once.** Work is delivered in small,
   reviewable phases.
2. **Only work on the phase explicitly requested.** No anticipatory work on
   future phases.
3. **Do not proceed to the next phase automatically.** Stop and wait for explicit
   instruction after each phase.
4. **Before modifying code, inspect existing files.** Read the relevant modules,
   configs, and tests first; never edit blind.
5. **Do not rewrite unrelated modules.** Keep diffs scoped to the phase. If
   adjacent code needs fixing, flag it instead of rewriting it.
6. **Every phase must include:**
   - Acceptance criteria
   - Tests
   - Manual testing checklist
   - Files created
   - Files modified
7. **If requirements are unclear, ask questions before coding.** Do not guess at
   ambiguous requirements; get clarification first.
8. **Optimize for maintainability, not speed.** Prefer clear module boundaries,
   explicit contracts, and boring, proven patterns over clever shortcuts.
9. **Do not use copyrighted music during development.** Use only synthesized,
   procedurally generated, or explicitly royalty-free placeholder audio and
   artwork for development, tests, and demos.
10. **Stop after completing the requested phase.** Report what was done and wait.

## Phase Discipline

- Each phase has a written scope. Work outside that scope is out of bounds.
- Definition of done for a phase: all acceptance criteria met, tests added and
  passing, manual testing checklist completed, and the five required sections
  (above) documented in the phase report.
- Architectural decisions with lasting impact are recorded as ADRs
  (Architecture Decision Records) in `docs/adr/`.
- No phase is "done" until its report exists. Code without the report does not
  count as complete.

## Suggested Phase Roadmap (first 10)

Ordered for dependency safety: each phase builds only on capabilities shipped
by earlier phases.

1. **Phase 1 — Foundation & Tooling.** Monorepo layout, language/toolchain
   choices, lint/format, CI/CD pipelines, environments (dev/staging/prod),
   observability baseline, ADR process.
2. **Phase 2 — Identity & Access.** User accounts, sign-up/login, OAuth/SSO,
   session/token strategy, user profiles.
3. **Phase 3 — Catalog & Metadata Service.** Data model for artists, albums,
   tracks; catalog API (read paths); seed data with royalty-free placeholders.
4. **Phase 4 — Artist Upload & Ingestion.** Upload API, file validation,
   artwork handling, async transcoding pipeline, storage layout.
5. **Phase 5 — Streaming & Playback Core.** Streaming protocol choice
   (e.g. HLS), CDN strategy, playback APIs, entitlement checks on streams,
   audio session handling.
6. **Phase 6 — Search & Discovery.** Full-text search over catalog, indexing
   strategy, search API, basic browse/discovery surfaces.
7. **Phase 7 — Playlists & Library.** Playlist CRUD, track ordering, likes,
   follows, library aggregation APIs.
8. **Phase 8 — Subscriptions & Monetization.** Plans, billing integration,
   entitlements/paywall enforcement, subscription lifecycle (upgrade, cancel,
   restore), artist payout scaffolding.
9. **Phase 9 — Mobile Clients (iOS & Android).** Native apps: auth, browse,
   search, playback with background audio, offline scaffolding, playlist
   management.
10. **Phase 10 — CarPlay (and Android Auto).** CarPlay entitlement and setup,
    browseable templates, Now Playing, queue control, voice/Siri integration
    points.

## Architecture Principles

- Clear module/service boundaries with explicit API contracts.
- Boring technology where possible; novelty only where it earns its place.
- Security and privacy by default: least privilege, no secrets in code, PII
  handled deliberately.
- Accessibility and internationalization are requirements, not stretch goals.
- Everything observable: structured logs, metrics, and traces from day one.
