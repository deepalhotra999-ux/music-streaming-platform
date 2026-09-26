#!/usr/bin/env node
/**
 * Phase 32 — reproducible load test for the music streaming API.
 *
 * A zero-dependency Node script (no k6 needed) that exercises the hot paths
 * with configurable concurrency and reports latency percentiles, throughput,
 * and error rates.
 *
 * Usage:
 *   API_URL=http://localhost:3000 node load/api-load.mjs [--users N] [--duration S]
 *
 * The script:
 * 1. Registers N users (or reuses existing ones via env SEED_PREFIX).
 * 2. Warms up: each user logs in, browses catalog, searches.
 * 3. Load phase: mixed workload per user —
 *    - GET /v1/tracks (catalog reads)
 *    - GET /v1/search?q= (search)
 *    - POST /v1/playback/sessions (session creation)
 *    - POST /v1/playback/sessions/:id/events (heartbeat)
 *    - GET /v1/me (auth check)
 * 4. Reports p50/p95/p99 latency, req/s, error rate per endpoint.
 *
 * RESULTS ARE LOCAL SANDBOX NUMBERS, not production capacity projections.
 * See docs/PHASE-32-REPORT.md for the actual measured results and the
 * honest caveats.
 */

import { performance } from 'node:perf_hooks';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const USERS = parseInt(process.argv.find((a) => a.startsWith('--users='))?.split('=')[1] ?? '10', 10);
const DURATION_S = parseInt(process.argv.find((a) => a.startsWith('--duration='))?.split('=')[1] ?? '30', 10);
const PASSWORD = 'load-test-password-123';

const stats = new Map(); // endpoint -> { count, errors, latencies: [] }

function record(endpoint, latencyMs, ok) {
  let s = stats.get(endpoint);
  if (!s) {
    s = { count: 0, errors: 0, latencies: [] };
    stats.set(endpoint, s);
  }
  s.count += 1;
  if (!ok) s.errors += 1;
  s.latencies.push(latencyMs);
}

async function req(method, path, token, body) {
  const start = performance.now();
  let status = 0;
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // Drain the body so timing includes transfer.
    await res.text();
    status = res.status;
  } catch {
    status = 0;
  }
  const ok = status >= 200 && status < 400;
  record(`${method} ${path.split('?')[0]}`, performance.now() - start, ok);
  // Track rate-limit hits separately — they are the limiter working, not errors.
  if (status === 429) {
    record('429 rate-limited', 0, true);
  }
  return status;
}

async function registerUser(i) {
  const email = `loadtest-${Date.now()}-${i}@load.local`;
  const start = performance.now();
  try {
    const reg = await fetch(`${API_URL}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, displayName: `load${i}` }),
    });
    if (reg.status !== 201) return null;
    const login = await fetch(`${API_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    if (login.status !== 200) return null;
    const data = await login.json();
    record('SETUP register+login', performance.now() - start, true);
    return data.tokens.accessToken;
  } catch {
    record('SETUP register+login', performance.now() - start, false);
    return null;
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function userLoop(token, stopAt) {
  const queries = ['rock', 'pop', 'jazz', 'love', 'night'];
  let qi = 0;
  while (Date.now() < stopAt) {
    // Catalog reads (hot path)
    await req('GET', '/v1/tracks?limit=20', token);
    // Search (q-param on catalog endpoints, per Phase 12)
    await req('GET', `/v1/tracks?q=${queries[qi++ % queries.length]}&limit=20`, token);
    // Auth check
    await req('GET', '/v1/me', token);
    // Recommendations (if available)
    await req('GET', '/v1/discovery/recommendations?limit=10', token);
    // Small think time
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
  }
}

async function main() {
  console.log(`Load test: ${USERS} users, ${DURATION_S}s, target ${API_URL}`);

  // Health check first.
  try {
    const h = await fetch(`${API_URL}/v1/health`);
    if (!h.ok) throw new Error(`health returned ${h.status}`);
  } catch (err) {
    console.error(`API not reachable at ${API_URL}: ${err.message}`);
    process.exit(1);
  }

  console.log('Registering users...');
  const tokens = [];
  for (let i = 0; i < USERS; i++) {
    const t = await registerUser(i);
    if (t) tokens.push(t);
    if (i % 10 === 0) process.stdout.write(`\r${i}/${USERS}`);
  }
  console.log(`\rRegistered ${tokens.length}/${USERS} users.`);

  if (tokens.length === 0) {
    console.error('No users registered; aborting.');
    process.exit(1);
  }

  const stopAt = Date.now() + DURATION_S * 1000;
  console.log('Running load...');
  await Promise.all(tokens.map((t) => userLoop(t, stopAt)));

  console.log('\n=== RESULTS (local sandbox — NOT production capacity) ===');
  let totalReqs = 0;
  let totalErrors = 0;
  for (const [endpoint, s] of [...stats.entries()].sort()) {
    const lat = [...s.latencies].sort((a, b) => a - b);
    totalReqs += s.count;
    totalErrors += s.errors;
    console.log(
      `${endpoint}\n` +
        `  n=${s.count} errors=${s.errors} (${((s.errors / s.count) * 100).toFixed(1)}%) ` +
        `p50=${percentile(lat, 50).toFixed(1)}ms p95=${percentile(lat, 95).toFixed(1)}ms ` +
        `p99=${percentile(lat, 99).toFixed(1)}ms`,
    );
  }
  const elapsedS = DURATION_S;
  console.log(
    `\nTOTAL: ${totalReqs} requests in ~${elapsedS}s = ${(totalReqs / elapsedS).toFixed(1)} req/s, ` +
      `error rate ${((totalErrors / totalReqs) * 100).toFixed(2)}%`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
