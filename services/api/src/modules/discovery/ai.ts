// Phase 26 — provider-neutral AI discovery interface.
//
// The AI layer interprets natural-language discovery requests and produces
// a structured DiscoveryConstraints object. It NEVER returns music objects
// directly, and its output is always schema-validated (see sanitize.ts)
// and re-resolved against the real catalog (see authz.ts) before use.
//
// Privacy boundary (hard rules):
// - The provider receives only the NL query text plus non-identifying
//   catalog context (genre names, never user data).
// - NEVER: user identity, raw listening history, auth tokens,
//   payment/subscription data, private playlist contents.
// - The development environment works without any AI credentials: the
//   deterministic local provider handles NL parsing, and tests use the
//   mock provider.
//
// Environment variables for a real provider (documented, never committed):
//   DISCOVERY_AI_PROVIDER   "none" | "openai" | "anthropic" (default "none")
//   DISCOVERY_AI_API_KEY    API key (never logged, never sent to clients)
//   DISCOVERY_AI_MODEL      model name (provider default if unset)
//   DISCOVERY_AI_TIMEOUT_MS request timeout (default 8000)

import type { PrismaClient } from '@prisma/client';
import type { DiscoveryConstraints } from './types.js';

type Db = PrismaClient;

export interface AIInterpretInput {
  /** Raw natural-language query from the user. */
  query: string;
  /** Non-identifying catalog context: genre names only. */
  genreNames: string[];
  /** Requested result limit (already clamped by policy). */
  limit: number;
}

export interface AIProviderResult {
  constraints: DiscoveryConstraints;
  /** Which provider produced this (for telemetry + policy metadata). */
  providerName: string;
}

/**
 * Provider-neutral boundary. Implementations must be pure with respect to
 * side effects: no catalog writes, no royalty/subscription access, no
 * network calls outside their own configured endpoint.
 */
export interface RecommendationAIProvider {
  readonly name: string;
  interpret(input: AIInterpretInput): Promise<AIProviderResult>;
}

function baseConstraints(limit: number): DiscoveryConstraints {
  return {
    genreIds: [],
    moods: [],
    energy: null,
    tempoBpm: null,
    era: null,
    artistIds: [],
    emergingOnly: false,
    limit,
    exploration: 0.5,
  };
}

/**
 * Deterministic local NL interpreter. Keyword-based, no network, no
 * credentials. Handles the brief's example queries:
 *   "mellow indie music for studying"  -> low energy, indie-ish genres
 *   "energetic music for a workout"    -> high energy
 *   "emerging Canadian artists"        -> emergingOnly (geo is a soft hint;
 *                                         the catalog has no country column)
 *   "late-night drive"                 -> moods
 *   "artists similar to what I've been listening to" -> exploration low,
 *                                         relies on signal-based candidates
 *
 * Genre name matching resolves against real genre names passed in; unknown
 * words never become IDs (IDs are resolved server-side later).
 */
export class DeterministicAIProvider implements RecommendationAIProvider {
  readonly name = 'deterministic';

  constructor(private readonly db: Db) {}

  async interpret(input: AIInterpretInput): Promise<AIProviderResult> {
    const q = input.query.toLowerCase();
    const c = baseConstraints(input.limit);

    // Energy / mood keywords.
    if (/\b(mellow|chill|relax|calm|study|sleep|ambient|soft)\b/.test(q)) {
      c.energy = 0.25;
      c.moods.push('mellow');
    }
    if (/\b(energetic|workout|party|dance|hype|upbeat|running)\b/.test(q)) {
      c.energy = 0.85;
      c.moods.push('energetic');
    }
    if (/\b(late[- ]night|night drive|midnight)\b/.test(q)) {
      c.moods.push('late-night');
      if (c.energy === null) c.energy = 0.4;
    }
    if (/\b(focus|concentrat)\b/.test(q)) {
      c.moods.push('focus');
      if (c.energy === null) c.energy = 0.35;
    }

    // Emerging artists.
    if (/\b(emerging|new artists|up[- ]and[- ]coming|discover new)\b/.test(q)) {
      c.emergingOnly = true;
      c.exploration = 1.0;
    }

    // Similarity to current taste -> lean on signals, low exploration.
    if (/\b(similar to|like what i (listen|play)|my taste|for me)\b/.test(q)) {
      c.exploration = 0.2;
    }

    // Genre names: match real genre names as whole words.
    if (input.genreNames.length > 0) {
      const matched = await this.db.genre.findMany({
        where: { name: { in: input.genreNames, mode: 'insensitive' } },
        select: { id: true, name: true },
      });
      for (const g of matched) {
        if (q.includes(g.name.toLowerCase())) c.genreIds.push(g.id);
      }
    }

    // Era hints (soft, free-text).
    const eraMatch = q.match(/\b(19[6-9]0s|20[0-2]0s)\b/);
    if (eraMatch) c.era = eraMatch[1];

    return { constraints: c, providerName: this.name };
  }
}

/**
 * Mock provider for tests. Returns canned constraints; proves the pipeline
 * works without any real AI and lets tests assert validation behavior.
 */
export class MockAIProvider implements RecommendationAIProvider {
  readonly name = 'mock';
  constructor(private readonly canned: DiscoveryConstraints) {}
  async interpret(_input: AIInterpretInput): Promise<AIProviderResult> {
    // Return the canned value verbatim (no spread): spreading a non-object
    // (e.g. a garbage string) would convert it into an object and defeat
    // validation, hiding invalid provider output.
    return { constraints: this.canned, providerName: this.name };
  }
}

/**
 * A provider that always fails, used to prove graceful deterministic
 * fallback when AI is unavailable.
 */
export class FailingAIProvider implements RecommendationAIProvider {
  readonly name = 'failing';
  async interpret(_input: AIInterpretInput): Promise<AIProviderResult> {
    throw new Error('AI provider unavailable');
  }
}

export interface AIProviderConfig {
  provider: string;
  apiKey?: string;
  model?: string;
  timeoutMs: number;
}

export function aiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AIProviderConfig {
  return {
    provider: (env.DISCOVERY_AI_PROVIDER ?? 'none').toLowerCase(),
    apiKey: env.DISCOVERY_AI_API_KEY,
    model: env.DISCOVERY_AI_MODEL,
    timeoutMs: Number(env.DISCOVERY_AI_TIMEOUT_MS ?? 8000),
  };
}

/**
 * Select the AI provider. "none" (default) and any unknown value resolve to
 * the deterministic local provider — the system must work without
 * production AI credentials. Real vendor providers are constructed here in
 * the future; they must implement RecommendationAIProvider and obey the
 * privacy boundary above.
 */
export function createAIProvider(
  db: Db,
  config: AIProviderConfig = aiConfigFromEnv(),
): RecommendationAIProvider {
  switch (config.provider) {
    case 'none':
    default:
      return new DeterministicAIProvider(db);
  }
}
