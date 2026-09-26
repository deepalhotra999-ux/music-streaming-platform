# Releases: OTA app updates + server deployments

This project ships updates two ways, both triggerable without reinstalling
anything by hand:

| What changes | Mechanism | Trigger |
|---|---|---|
| Mobile JS/assets (no native changes) | Expo EAS Update (OTA) | `eas update` from your machine, or auto-check in the app |
| Server code / admin console | GitHub Actions CD | Admin console → **Releases** → Deploy |

Native mobile changes (new native module, SDK bump, permissions) still
require a new store binary — OTA cannot change native code.

## 1. Mobile OTA updates (EAS Update)

### One-time setup

1. Create an EAS project: `eas init` inside `apps/mobile` (or link an existing
   project on expo.dev).
2. Replace the placeholder values in `apps/mobile/app.json`:
   - `updates.url`: `https://u.expo.dev/<your-project-id>`
   - `extra.eas.projectId`: `<your-project-id>`
   
   The placeholders are all-zero UUIDs and are intentionally inert — OTA is
   disabled until you set a real project ID.
3. Make sure `runtimeVersion` in `app.json` uses the app version policy
   (`{ "policy": "appVersion" }` is the current setting). Every published OTA
   update only applies to installs whose runtime version matches.

### Publishing an update

```bash
cd apps/mobile
eas update --branch production --message "Fixes player seek bar"
```

Channels map to release stages: publish to `preview` for internal testing,
`production` for the store build. The app's Profile → **App updates** section
shows the current channel, update ID, and runtime version, and offers a
manual "Check for updates".

### How the client behaves (`apps/mobile/src/updates/`)

- Checks automatically on launch and on foreground (throttled to once per
  30 minutes).
- Downloads in the background; when ready, Profile shows **Restart to apply
  update** — the update is applied on the next launch.
- In Expo Go / development builds OTA reports "unavailable" instead of
  failing.

### Rollback

Publish the previous known-good JS bundle again with `eas update`, or
republish with the fix. There is no server-side state to clean up — the
client simply fetches the latest compatible update for its runtime version.

## 2. Server deployments (admin-triggered CD)

### How it works

1. Admin console → **Releases** → enter a branch/tag (default `main`) →
   confirm **Deploy**.
2. The API (`POST /v1/admin/deploy`) fires a `deploy-requested`
   `repository_dispatch` event to GitHub. It does **not** upload or execute
   any code — the token and the git history stay where they are.
3. `.github/workflows/cd.yml` checks out the requested ref, runs the full
   verify pipeline (typecheck, lint, tests, build, migration dry-run), then
   deploys over SSH with `docker-compose.prod.yml` and smoke-tests
   `/v1/health`.
4. The **Recent runs** table on the Releases page shows the workflow runs.

### One-time setup

**API environment** (`services/api/.env`, see `.env.example`):

- `GITHUB_DEPLOY_TOKEN` — a fine-grained personal access token with
  **Actions: read and write** on this repository. Without it the endpoints
  fail closed (HTTP 503) and the admin page shows setup instructions.
- `GITHUB_DEPLOY_REPO` — `owner/repo` (defaults to
  `deepalhotra999-ux/music-streaming-platform`).
- `RATE_LIMIT_DEPLOY` — max deploy triggers per window (default 10).

**GitHub repository secrets** (Settings → Secrets and variables → Actions):

- `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_DIR`,
  `DEPLOY_ENV_B64` (base64-encoded production `.env` for the API container),
  optional `DEPLOY_PORT`.

Until `DEPLOY_HOST` is set, the CD `deploy` job is **skipped** (not failed) —
verify still runs, and the run summary says deployments aren't configured.
This is deliberate: no silent half-deployments.

### Security notes

- The GitHub token lives only in server env. It never appears in API
  responses, logs, or audit metadata (`deploy.triggered` records ref +
  event type only).
- Deploy triggers are ADMIN-only and rate-limited.
- The requested ref is validated both in the API and in the workflow against
  a git-ref-safe charset — no shell injection through the ref.
- Every successful trigger is written to the append-only admin audit log.

### Rollback

Redeploy the previous known-good ref from the Releases page (enter the
branch/tag or the commit's ref). Database migrations are forward-only —
check the migration's reversibility before rolling back across a schema
change.

## 3. What this deliberately does NOT do

- The admin console cannot upload code, binaries, or assets to the server.
  Arbitrary file upload that executes or replaces server code would be a
  remote-code-execution surface and is out of scope.
- OTA updates cannot change native code, permissions, or the app version.
