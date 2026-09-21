#!/usr/bin/env node
// Phase 18 — live API verification: subscription lifecycle, entitlement
// gating, spoofing resistance, idempotency, and regression checks.

const BASE = process.env.API_BASE ?? 'http://localhost:4100';
let failures = 0;

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const email = `phase18-live-${Date.now()}@example.com`;

async function main() {
  console.log('== register/login ==');
  const reg = await req('POST', '/v1/auth/register', {
    body: { email, password: 'Correct-Horse-99!', displayName: 'Phase18 Live' },
  });
  check('register 201', reg.status === 201, `got ${reg.status}: ${reg.text.slice(0, 120)}`);
  const login = await req('POST', '/v1/auth/login', { body: { email, password: 'Correct-Horse-99!' } });
  check('login 200', login.status === 200, `got ${login.status}`);
  const token = login.json?.tokens?.accessToken;
  check('access token issued', typeof token === 'string');

  console.log('== no subscription: playback denied ==');
  const ent0 = await req('GET', '/v1/subscriptions/me/entitlement', { token });
  check('entitlement 200', ent0.status === 200, `got ${ent0.status}`);
  check('not entitled', ent0.json?.entitled === false, JSON.stringify(ent0.json));
  check('reason no_subscription', ent0.json?.reason === 'no_subscription', ent0.json?.reason);

  const me0 = await req('GET', '/v1/subscriptions/me', { token });
  check('me: no subscription', me0.status === 200 && me0.json?.subscription === null, `got ${me0.status}`);

  // Need a READY track id for playback attempts.
  const tracks = await req('GET', '/v1/tracks?limit=20', { token });
  const trackId = tracks.json?.data?.find((t) => t.status === 'READY')?.id
    ?? tracks.json?.data?.[0]?.id;
  check('seed track available', typeof trackId === 'string', `got ${trackId}`);

  const sess0 = await req('POST', '/v1/playback/sessions', { token, body: { trackId } });
  check('playback denied without subscription (403)', sess0.status === 403, `got ${sess0.status}`);
  check('RFC 7807 subscription-required title', sess0.json?.title === 'Subscription Required', sess0.json?.title);

  console.log('== DEV event: subscription started ==');
  const extSubId = `dev-live-${Date.now()}`;
  const started = await req('POST', '/v1/dev/subscription-events', {
    token,
    body: {
      providerEventId: `evt-live-started-${Date.now()}`,
      eventType: 'SUBSCRIPTION_STARTED',
      externalSubscriptionId: extSubId,
      planCode: 'premium_individual',
      periodStart: new Date(Date.now() - 86400_000).toISOString(),
      periodEnd: new Date(Date.now() + 30 * 86400_000).toISOString(),
    },
  });
  check('DEV event accepted (201)', started.status === 201, `got ${started.status}: ${started.text.slice(0, 120)}`);
  check('returns ACTIVE', started.json?.subscription?.status === 'ACTIVE', started.json?.subscription?.status);

  console.log('== entitled: playback allowed ==');
  const ent1 = await req('GET', '/v1/subscriptions/me/entitlement', { token });
  check('entitled now', ent1.json?.entitled === true, JSON.stringify(ent1.json));
  check('planCode premium_individual', ent1.json?.planCode === 'premium_individual', ent1.json?.planCode);

  const me1 = await req('GET', '/v1/subscriptions/me', { token });
  check('me: no external ids leaked', me1.json?.subscription?.externalSubscriptionId === undefined, JSON.stringify(Object.keys(me1.json?.subscription ?? {})));
  check('me: no user id leaked', me1.json?.subscription?.userId === undefined);

  const sess1 = await req('POST', '/v1/playback/sessions', { token, body: { trackId } });
  check('playback session created (201)', sess1.status === 201, `got ${sess1.status}: ${sess1.text.slice(0, 120)}`);
  const hlsUrl = sess1.json?.hlsUrl;
  check('hlsUrl present', typeof hlsUrl === 'string');
  const sessionId = sess1.json?.id;

  console.log('== expire: new sessions denied, existing session survives ==');
  const expired = await req('POST', '/v1/dev/subscription-events', {
    token,
    body: {
      providerEventId: `evt-live-expired-${Date.now()}`,
      eventType: 'SUBSCRIPTION_EXPIRED',
      externalSubscriptionId: extSubId,
      planCode: 'premium_individual',
    },
  });
  check('expire event accepted', expired.status === 201 && expired.json?.subscription?.status === 'EXPIRED', `got ${expired.status}`);

  const ent2 = await req('GET', '/v1/subscriptions/me/entitlement', { token });
  check('no longer entitled', ent2.json?.entitled === false, JSON.stringify(ent2.json));

  const sess2 = await req('POST', '/v1/playback/sessions', { token, body: { trackId } });
  check('new session denied after expiry (403)', sess2.status === 403, `got ${sess2.status}`);

  // Existing issued session still delivers HLS (token-based, 15-min TTL).
  const master = await fetch(`${BASE}${hlsUrl}`);
  check('existing session HLS still served (200)', master.status === 200, `got ${master.status}`);

  console.log('== spoofing resistance ==');
  // The playback endpoint takes no client flags; there is nothing to spoof.
  // A request with a fabricated premium claim in the body must not bypass.
  const spoof = await req('POST', '/v1/playback/sessions', {
    token,
    body: { trackId, premium: true, subscriptionStatus: 'ACTIVE' },
  });
  check('extra client flags do not bypass (403)', spoof.status === 403, `got ${spoof.status}`);

  console.log('== idempotency ==');
  const evtId = `evt-live-dup-${Date.now()}`;
  const dupBody = {
    providerEventId: evtId,
    eventType: 'SUBSCRIPTION_STARTED',
    externalSubscriptionId: `dev-live-dup-${Date.now()}`,
    planCode: 'premium_family',
    periodEnd: new Date(Date.now() + 30 * 86400_000).toISOString(),
  };
  const d1 = await req('POST', '/v1/dev/subscription-events', { token, body: dupBody });
  const d2 = await req('POST', '/v1/dev/subscription-events', { token, body: dupBody });
  check('duplicate event accepted twice (201/200)', d1.status === 201 && d2.status === 200, `got ${d1.status}/${d2.status}`);
  check('second delivery marked duplicate', d2.json?.duplicate === true, JSON.stringify(d2.json));

  // History should show the events (started, expired, started-dup => 2 rows for started? no: 1 row for dup).
  // Admin view of history.
  console.log('== admin inspection ==');
  // Need an admin token. Use the seeded admin if present, else skip.
  const adminLogin = await req('POST', '/v1/auth/login', {
    body: { email: 'admin@example.com', password: 'admin' },
  });
  if (adminLogin.status === 200) {
    const adminToken = adminLogin.json.tokens.accessToken;
    const insp = await req('GET', `/v1/admin/users/${reg.json.user.id}/subscription`, { token: adminToken });
    check('admin inspection 200', insp.status === 200, `got ${insp.status}: ${insp.text.slice(0, 120)}`);
    check('admin sees status', typeof insp.json?.subscription?.status === 'string', JSON.stringify(insp.json?.subscription));
    check('admin sees entitlement', typeof insp.json?.entitlement?.entitled === 'boolean');
    check('admin sees history', Array.isArray(insp.json?.events), JSON.stringify(insp.json?.events?.length));
    // Non-admin must be denied.
    const forbidden = await req('GET', `/v1/admin/users/${reg.json.user.id}/subscription`, { token });
    check('non-admin denied (403)', forbidden.status === 403, `got ${forbidden.status}`);
  } else {
    console.log('  skip admin checks (no seeded admin credentials)');
  }

  console.log('== regression: catalog + moderation ==');
  const search = await req('GET', '/v1/tracks?q=love&limit=2', { token });
  check('catalog search 200', search.status === 200, `got ${search.status}`);
  const lib = await req('GET', '/v1/me/playlists', { token });
  check('library 200', lib.status === 200, `got ${lib.status}`);

  console.log(failures === 0 ? '\nALL LIVE CHECKS PASSED' : `\n${failures} LIVE CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('live verification crashed:', err);
  process.exit(1);
});
