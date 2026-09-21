// Phase 17 — live API verification script.
// Run with: node --experimental-strip-types scripts/phase17-live-verify.ts
// (or compile first). Requires the API on localhost:3000 and seeded DB.

const BASE = 'http://localhost:3000';

interface TokenPair {
  accessToken: string;
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  const body = (await res.json()) as { tokens: TokenPair };
  return body.tokens.accessToken;
}

async function api(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, json };
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('Phase 17 live verification\n');

  // Throwaway live-test users registered via /v1/auth/register (password:
  // TestPassword123!); liveadmin17 was promoted to ADMIN with the dev
  // set-user-role script. Cleaned up after the run.
  const PW = 'TestPassword123!';
  const adminToken = await login('liveadmin17@phase17.test', PW);
  const artistToken = await login('liveartist17@phase17.test', PW);
  const listenerToken = await login('livelistener17@phase17.test', PW);
  console.log('  tokens acquired (admin, artist, listener)\n');

  // --- 1. ADMIN moderation flows ---
  console.log('ADMIN moderation flows:');
  const trackList = await api('GET', '/v1/tracks?limit=1', adminToken);
  const trackId = (trackList.json as { data: Array<{ id: string }> }).data[0]?.id;
  check('seed has a track', !!trackId);

  const created = await api('POST', '/v1/admin/moderation-reports', adminToken, {
    targetType: 'TRACK',
    targetId: trackId,
    reason: 'Live verification report',
    details: 'Automated check',
  });
  check('ADMIN can file a moderation report (201)', created.status === 201, `got ${created.status}`);
  const reportId = (created.json as { id: string }).id;

  const listed = await api('GET', '/v1/admin/moderation-reports?status=OPEN', adminToken);
  check('ADMIN can list reports', listed.status === 200);

  const fetched = await api('GET', `/v1/admin/moderation-reports/${reportId}`, adminToken);
  check('ADMIN can fetch report detail', fetched.status === 200);

  const transitioned = await api('PATCH', `/v1/admin/moderation-reports/${reportId}`, adminToken, {
    status: 'UNDER_REVIEW',
  });
  check(
    'ADMIN can transition OPEN → UNDER_REVIEW',
    transitioned.status === 200 &&
      (transitioned.json as { status: string }).status === 'UNDER_REVIEW',
  );

  const resolved = await api('PATCH', `/v1/admin/moderation-reports/${reportId}`, adminToken, {
    status: 'RESOLVED',
  });
  check('ADMIN can transition UNDER_REVIEW → RESOLVED', resolved.status === 200);

  const reopened = await api('PATCH', `/v1/admin/moderation-reports/${reportId}`, adminToken, {
    status: 'OPEN',
  });
  check('terminal RESOLVED rejects reopening (422)', reopened.status === 422, `got ${reopened.status}`);

  // --- 2. LISTENER/ARTIST 403s on every new admin endpoint ---
  console.log('\nNon-admin 403 checks:');
  // Use a valid UUID so schema validation passes and the authz check runs.
  const probeId = '00000000-0000-0000-0000-000000000000';
  for (const [label, token] of [
    ['LISTENER', listenerToken],
    ['ARTIST', artistToken],
  ] as const) {
    const paths: Array<[string, string, unknown?]> = [
      ['POST', '/v1/admin/moderation-reports', { targetType: 'TRACK', targetId: trackId, reason: 'x'.repeat(5) }],
      ['GET', '/v1/admin/moderation-reports', undefined],
      ['GET', `/v1/admin/moderation-reports/${reportId}`, undefined],
      ['PATCH', `/v1/admin/moderation-reports/${reportId}`, { status: 'DISMISSED' }],
      ['GET', `/v1/admin/users/${probeId}`, undefined],
    ];
    for (const [method, path, body] of paths) {
      const r = await api(method, path, token, body);
      check(`${label} ${method} ${path.split('?')[0]} → 403`, r.status === 403, `got ${r.status}`);
    }
  }

  // Unauthenticated → 401 on admin endpoints.
  const unauth = await api('GET', '/v1/admin/moderation-reports', null);
  check('unauthenticated GET /v1/admin/moderation-reports → 401', unauth.status === 401, `got ${unauth.status}`);

  // --- 3. Admin user detail + includeDeleted ---
  console.log('\nAdmin user detail:');
  const me = await api('GET', '/v1/me', adminToken);
  const adminId = (me.json as { id: string }).id;
  const detail = await api('GET', `/v1/admin/users/${adminId}`, adminToken);
  const detailJson = detail.json as Record<string, unknown>;
  check('ADMIN can fetch user detail (200)', detail.status === 200);
  check('detail includes ownedArtists array', Array.isArray(detailJson.ownedArtists));
  check('detail excludes passwordHash', !('passwordHash' in detailJson));
  check('detail excludes refreshTokens', !('refreshTokens' in detailJson));

  const withDeleted = await api('GET', '/v1/users?includeDeleted=true', adminToken);
  check('ADMIN includeDeleted works (200)', withDeleted.status === 200);

  // --- 4. Track takedown/restore (audited) ---
  console.log('\nTrack takedown / restore:');
  const takedown = await api('PATCH', `/v1/tracks/${trackId}`, adminToken, { status: 'TAKEDOWN' });
  check('ADMIN can take down a track', takedown.status === 200);

  // Takedown blocks streaming: playback sessions require READY status.
  // (Public list metadata visibility is pre-existing behavior; the audio
  // itself is protected by the streaming layer's READY check.)
  const session = await api('POST', '/v1/playback/sessions', listenerToken, { trackId });
  check(
    'taken-down track cannot start a playback session (409)',
    session.status === 409,
    `got ${session.status}`,
  );

  const listenerTakedown = await api('PATCH', `/v1/tracks/${trackId}`, listenerToken, {
    status: 'TAKEDOWN',
  });
  check('LISTENER track takedown → 403', listenerTakedown.status === 403, `got ${listenerTakedown.status}`);

  const restore = await api('PATCH', `/v1/tracks/${trackId}`, adminToken, { status: 'PROCESSING' });
  check('ADMIN can restore a track to PROCESSING', restore.status === 200);

  // --- 5. Audit verification ---
  console.log('\nAudit log verification:');
  const audit = await api(
    'GET',
    `/v1/admin/audit-logs?targetType=moderation_report&targetId=${reportId}&limit=50`,
    adminToken,
  );
  const entries = ((audit.json as { data: Array<{ action: string }> }).data ?? []).map((e) => e.action);
  check('audit has moderation.report.created', entries.includes('moderation.report.created'));
  check('audit has moderation.report.status_changed', entries.includes('moderation.report.status_changed'));

  const trackAudit = await api(
    'GET',
    `/v1/admin/audit-logs?targetType=track&targetId=${trackId}&limit=50`,
    adminToken,
  );
  const trackActions = ((trackAudit.json as { data: Array<{ action: string }> }).data ?? []).map(
    (e) => e.action,
  );
  check('audit has track.status.changed (takedown)', trackActions.includes('track.status.changed'));

  const listenerAudit = await api('GET', '/v1/admin/audit-logs', listenerToken);
  check('LISTENER audit-log access → 403', listenerAudit.status === 403, `got ${listenerAudit.status}`);

  // --- 6. Audit immutability (DB trigger) ---
  console.log('\nAudit immutability:');
  const firstEntry = (audit.json as { data: Array<{ id: string }> }).data[0];
  if (firstEntry) {
    const { execSync } = await import('node:child_process');
    let blocked = false;
    try {
      execSync(
        `PGPASSWORD=musicpw psql -h localhost -U music -d musicdb -c "UPDATE admin_audit_logs SET action='tampered' WHERE id='${firstEntry.id}';"`,
        { stdio: 'pipe' },
      );
    } catch {
      blocked = true;
    }
    check('UPDATE on admin_audit_logs is blocked by trigger', blocked);
  } else {
    check('audit row exists for immutability test', false, 'no entries');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('live verification crashed:', err);
  process.exit(1);
});
