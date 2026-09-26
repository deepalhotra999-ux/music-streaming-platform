# Deploy Guide — Music Streaming Platform

Takes the local demo to hosted infrastructure. You need accounts on:

1. **Railway** (API + PostgreSQL) — https://railway.app
2. **Cloudflare** (R2 audio storage) — https://dash.cloudflare.com
3. **Vercel** (admin dashboard) — https://vercel.com

## Step 1 — Railway: PostgreSQL + API

1. Create a Railway account, then a new project.
2. **Add PostgreSQL:** `+ New` → `Database` → `PostgreSQL`. Note the
   `DATABASE_URL` from the Variables tab.
3. **Deploy the API:** `+ New` → `GitHub Repo` → select this repo.
   - Set the **Root Directory** to `services/api`
   - Railway auto-detects the Dockerfile.
   - Add variables:
     - `DATABASE_URL` = the Postgres URL from step 2
     - `JWT_SECRET` = `openssl rand -base64 48` output
     - `NODE_ENV` = `production`
     - `AUDIO_STORAGE_DRIVER` = `s3`
     - `S3_BUCKET` = your R2 bucket name (step 2)
     - `S3_ENDPOINT` = your R2 endpoint (step 2)
     - `S3_REGION` = `auto`
     - `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` = R2 API token (step 2)
     - `CORS_ORIGIN` = your admin URL (step 3)
   - The container runs `prisma migrate deploy` on boot, then starts.
   - Verify: `https://<your-api>.up.railway.app/v1/health` → `{"status":"ok"}`
     and `/v1/ready` → `{"status":"ready"}`.

## Step 2 — Cloudflare R2: audio storage

1. Cloudflare dashboard → **R2** → Create bucket (e.g. `music-audio-prod`).
   Keep public access **blocked** — the API signs URLs server-side.
2. **Manage R2 API Tokens** → create a token with Object Read & Write on
   that bucket. Save the Access Key ID, Secret, and endpoint URL.
3. Paste those three values into the Railway variables from Step 1.
4. Migrate audio: download from local `services/api/storage/audio` and
   upload to the bucket preserving the `tracks/<id>/hls/...` key layout
   (`wrangler r2 object put` or the dashboard).

## Step 3 — Vercel: admin dashboard

1. `+ New Project` → import this repo.
   - **Root Directory:** `apps/admin`
   - Framework preset: Vite (auto-detected)
   - Environment variable: `VITE_API_URL=https://<your-api>.up.railway.app`
2. Deploy. Sign in with the admin account you create via the API.

## Step 4 — Create your admin user

```bash
# Against the hosted API:
curl -X POST https://<your-api>.up.railway.app/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"<strong-password>","displayName":"Owner"}'
# Then promote to ADMIN via Railway's Postgres query tab:
#   UPDATE users SET role='ADMIN' WHERE email='you@example.com';
```

## Step 5 — Mobile apps point at production

Set `EXPO_PUBLIC_API_URL=https://<your-api>.up.railway.app` at build time
(`eas build`). The apps then talk to the hosted backend.

## What stays mock/dev until launch work

- **Stripe:** set `COMMERCE_PAYMENT_PROVIDER=stripe` + live keys when ready.
- **Apple/Google subscriptions:** App Store Connect / Play Console setup.
- **Music licensing & legal:** see `docs/RELEASE-CANDIDATE-REPORT.md`.
