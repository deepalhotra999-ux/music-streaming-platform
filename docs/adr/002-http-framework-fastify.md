# 002. HTTP framework: Fastify

Date: 2026-09-21
Status: accepted

## Context

Phase 3 (Authentication) needs an HTTP layer for the API service. The choice of
framework affects every future phase (catalog, library, billing, ...), so it is
recorded here. Candidates: Express, Fastify, Hono, NestJS.

## Decision

Use **Fastify** for `services/api`.

- First-class TypeScript support (no `@types` drift).
- Built-in JSON Schema validation and serialization: request/response
  contracts are declared once and enforced at runtime — this pairs directly
  with the OpenAPI-first contract strategy in `packages/contracts`.
- Plugin architecture with encapsulation keeps module boundaries
  (`identity`, `catalog`, ...) honest as the monolith grows.
- Boring and proven in production; performance headroom without tuning.

Express was the "most boring" option but requires assembling validation,
serialization, and async-error handling from middleware. Hono is newer and
edge-oriented — not where this service runs. NestJS adds decorators and
indirection the team did not ask for.

## Consequences

- All HTTP endpoints are Fastify routes with JSON Schema validation.
- Auth guards are Fastify `preHandler` hooks (`app.authenticate`).
- RFC 7807 `application/problem+json` error responses via a central
  `setErrorHandler` (`src/http/errors.ts`).
- Rate limiting via `@fastify/rate-limit`; the default in-memory store is
  per-instance and must move to Redis before horizontal scaling (tracked as a
  known issue in each phase report until then).
