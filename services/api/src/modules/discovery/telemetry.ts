// Phase 26 — safe recommendation telemetry.
//
// Logged per request (structured log line, no PII):
//   requestId, policyVersion, candidateCount, finalCount, droppedCount,
//   aiProvider (name or "deterministic-fallback"), latencyMs,
//   failureCategory (null on success), personalized (bool)
//
// NEVER logged: raw listening history, auth tokens, payment data, private
// playlist contents, full NL prompts. The NL query text itself is not
// logged (it may contain sensitive free text); only its length bucket.

export interface DiscoveryTelemetry {
  requestId: string;
  policyVersion: string;
  candidateCount: number;
  finalCount: number;
  droppedCount: number;
  aiProvider: string;
  latencyMs: number;
  failureCategory: string | null;
  personalized: boolean;
  /** Coarse bucket of the NL query length; never the query itself. */
  queryLengthBucket: 'none' | 'short' | 'medium' | 'long';
}

export function queryLengthBucket(query: string | null): DiscoveryTelemetry['queryLengthBucket'] {
  if (!query) return 'none';
  if (query.length <= 50) return 'short';
  if (query.length <= 200) return 'medium';
  return 'long';
}

export type TelemetrySink = (event: DiscoveryTelemetry) => void;

let sink: TelemetrySink = (event) => {
  // Default sink: structured log line. Safe fields only.
  console.log(JSON.stringify({ type: 'discovery.recommendation', ...event }));
};

/** Override the sink in tests. */
export function setTelemetrySink(next: TelemetrySink): void {
  sink = next;
}

export function emitTelemetry(event: DiscoveryTelemetry): void {
  try {
    sink(event);
  } catch {
    // Telemetry must never break recommendations.
  }
}
