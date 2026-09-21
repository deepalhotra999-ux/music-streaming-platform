// Phase 19 — injectable fetch for store adapters.
//
// Store adapters call Apple/Google over HTTP. In tests the network is
// replaced with a deterministic stub; in production this is the global
// fetch. The override is module-scoped and test-only — production code
// never calls setFetchImplForTests.

export type FetchImpl = typeof fetch;

let testFetchImpl: FetchImpl | null = null;

/** Test-only: replace the HTTP layer used by store adapters. */
export function setFetchImplForTests(fn: FetchImpl | null): void {
  testFetchImpl = fn;
}

/** Resolve the effective fetch: explicit > test override > global. */
export function resolveFetch(explicit?: FetchImpl): FetchImpl {
  return explicit ?? testFetchImpl ?? fetch;
}
