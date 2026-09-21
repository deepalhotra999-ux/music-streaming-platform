# Phase 5 Report — Mobile Foundation

Date: 2026-09-21
Status: **complete** (stopping here per phase discipline; Phase 6 not started)

## Scope delivered

React Native + TypeScript mobile foundation for iOS + Android, built with
Expo SDK 57 inside the existing monorepo at `apps/mobile`. The Fastify
backend was **not modified** — the app talks to the Phase 4 API over REST
only. Explicitly excluded per the brief: audio playback, HLS, music player,
playlists, search, subscriptions, payments, CarPlay, artist dashboard, AI,
offline downloads.

- **Navigation** — Expo Router (file-based) under `src/app/`: splash route,
  `(auth)` stack (login/register), `(tabs)` bottom tabs
  (Home/Search/Library/Profile).
- **Auth gating** — `Stack.Protected` guards in the root layout route by
  `AuthProvider` status: loading → splash, unauthenticated → auth stack,
  authenticated → tabs. No fake auth anywhere; all flows hit the real API.
- **Design system** — `src/theme/` (colors, typography, spacing/radii) and
  `src/components/` (Button, TextInput, Screen, Loading/Empty/ErrorState).
- **Reusable API client** — `src/api/ApiClient`: JSON handling, Bearer
  injection, single transparent retry with token rotation on 401, RFC 7807
  `ApiError` (status/title/detail/field errors), network-failure mapping.
- **Secure session persistence** — `expo-secure-store` (iOS Keychain /
  Android Keystore) via an injectable storage interface; session restored
  and validated against `GET /v1/me` on launch (one refresh attempt on 401);
  sign-out revokes server-side best-effort and always clears local state.
- **Screens** — Splash, Login, Register (real `POST /v1/auth/login` and
  `/v1/auth/register`, client + server validation, error banners),
  Home/Search/Library placeholders (empty states), Profile (account card +
  sign out).
- **States** — loading (splash, buttons), validation (inline field errors),
  empty (tab placeholders), error (banners, connectivity messages).

## Acceptance criteria → results

| Criterion | Result |
|---|---|
| React Native + TypeScript, inside the existing monorepo | ✅ Expo SDK 57 / RN 0.86.3 / TS at `apps/mobile` |
| Backend untouched (approved architecture) | ✅ `git status` shows zero changes under `services/`, `packages/`, `workers/` |
| Navigation (splash, auth, tabs) | ✅ Expo Router with `Stack.Protected` guards |
| Design system foundation | ✅ theme + Button/TextInput/Screen/states |
| Splash/Login/Register/Home/Search/Library/Profile screens | ✅ login/register real; tabs placeholder |
| Real Phase 4 API login/register (no fake auth) | ✅ verified live (see below) |
| Secure auth persistence | ✅ SecureStore; lifecycle unit-tested |
| Authenticated/unauthenticated navigation | ✅ guards; provider states tested |
| Loading/validation/empty/error states | ✅ |
| Reusable backend API client | ✅ `ApiClient` + endpoint wrappers |
| Mobile unit/component tests | ✅ 48 unit/component + 3 live |
| Tests, typecheck, lint, mobile build | ✅ all green (see Verification) |
| Exact Android emulator commands | ✅ below |
| Manual checklist | ✅ below |
| Known issues | ✅ below |
| All files reported | ✅ below |

## Verification (all green, 2026-09-21)

From `apps/mobile`:

| Check | Command | Result |
|---|---|---|
| Unit/component tests | `npm test` | **48/48 pass**, 6 suites |
| Live API tests | `npm run test:live` (API on `localhost:3000`) | **3/3 pass** — register 201 + token pair; wrong password → 401; login → `GET /v1/me` → refresh rotation → logout 204 → revoked refresh → 401 |
| Typecheck | `npm run typecheck` | clean |
| Lint | `npm run lint` | clean |
| Expo Doctor | `npx expo-doctor` | **21/21 checks pass** |
| Android bundle | `npm run export:android` | exported `dist/` (3.1 MB `.hbc`) |
| iOS bundle | `npm run export:ios` | exported `dist/` (2.8 MB `.hbc`) |

Live verification also confirmed against the real Phase 4 API: registration,
login, logout (refresh-token revocation), and session persistence semantics
(token rotation on 401). Test users (`waveform-live-*@example.com`) were
deleted from `musicdb` afterwards; no backend data or schema was changed.

## Exact commands

```bash
# --- backend (host machine, from repo root) ---
cd services/api
JWT_SECRET="$(openssl rand -base64 48)" \
DATABASE_URL="postgresql://music:music-dev-only-change-me@localhost:5432/musicdb" \
node dist/server.js
# (JWT_SECRET must be ≥ 32 chars; DATABASE_URL from services/api/.env)

# --- mobile (from apps/mobile) ---
npm test                 # 48 unit/component tests (no backend needed)
npm run typecheck        # tsc --noEmit
npm run lint             # eslint .
npm run test:live        # needs the API above on EXPO_PUBLIC_API_URL
                         # (default http://localhost:3000)
npm run export:android   # production Android JS bundle → dist/
npm run export:ios       # production iOS JS bundle → dist/

# --- Android emulator (needs Android SDK; NOT run in this sandbox) ---
# The app has native modules (expo-secure-store, expo-splash-screen), so it
# needs a development build — Expo Go will not work.
# 1. API running on the host (above).
# 2. The emulator reaches the host via 10.0.2.2, baked in at build time:
EXPO_PUBLIC_API_URL=http://10.0.2.2:3000 npx expo run:android
# 3. For iOS simulator (shares host network):
EXPO_PUBLIC_API_URL=http://localhost:3000 npx expo run:ios
```

## Manual checklist (on a dev build)

- [ ] Cold start shows the splash screen, then Login (no stored session).
- [ ] Register a new account → lands on the Home tab; Profile shows the
      display name, email, and role.
- [ ] Kill and relaunch the app → still signed in (session restored and
      validated against `GET /v1/me`).
- [ ] Profile → Sign out → returns to Login; relaunch stays signed out.
- [ ] Login with wrong password → red error banner
      ("Invalid email or password.").
- [ ] Login with empty fields → inline "Email is required." /
      "Password is required."; no network call.
- [ ] Register with a short password → "Password must be at least 12
      characters." before any network call.
- [ ] Airplane mode → login shows "Could not reach the server…".
- [ ] All four tabs render their placeholder empty states; tab bar icons
      and labels highlight correctly.
- [ ] Password fields have working Show/Hide toggles.

## Files created

```
apps/mobile/
  AGENTS.md                          # Expo house rules (read before working here)
  app.json                           # Expo config (Waveform, com.musicstreaming.waveform)
  babel.config.js                    # babel-preset-expo
  eslint.config.mjs                  # extends root config; Node/jest globals for tooling files
  jest.config.js                     # jest-expo preset; live suite excluded by default
  jest.live.config.js                # node env + live-only testMatch (explicit runs)
  jest.setup.js                      # mocks: expo-secure-store, expo-router, safe-area-context
  tsconfig.json                      # extends expo base; strict; types: jest,node
  package.json / package-lock.json   # standalone package (not a root workspace)
  index.ts                           # entry → expo-router/entry
  src/
    app/_layout.tsx                  # AuthProvider + Stack.Protected auth gating
    app/index.tsx                    # splash route
    app/(auth)/_layout.tsx           # unauthenticated stack
    app/(auth)/login.tsx  register.tsx
    app/(tabs)/_layout.tsx           # bottom tabs (Ionicons)
    app/(tabs)/index.tsx  search.tsx  library.tsx  profile.tsx
    api/{index,config,types,client,auth}.ts
    auth/{index,AuthContext,session,storage}.ts
    components/{index,Button,TextInput,Screen,States}.tsx
    screens/{index,Splash,Login,Register,Home,Search,Library,Profile}*.tsx
    theme/{index,colors,typography,spacing}.ts
    utils/validation.ts
    **/__tests__/                   # 48 unit/component tests (see below)
    api/__tests__/live/auth.live.test.ts   # 3 live tests (explicit runs only)
docs/adr/005-mobile-stack-expo-react-native.md   # mobile stack decision
docs/PHASE-5-REPORT.md               # this file
```

## Files modified

- `apps/mobile/app.json` — splash moved to `expo-splash-screen` plugin
  (SDK 57 schema removed the top-level `splash` key); formatted.
- `apps/mobile/package.json` (+ lockfile) — added `expo-splash-screen`,
  `expo-font`, `expo-constants`, `expo-linking`,
  `react-native-safe-area-context`, `@expo/vector-icons`, `babel-preset-expo`
  (all via `npx expo install` for SDK-compatible versions).
- `README.md` — phase status + layout updated (see below).

No changes to `services/`, `packages/`, `workers/`, or `infra/`.

## Test inventory

- `src/api/__tests__/client.test.ts` (8) — Bearer injection, 401→single
  refresh retry, no-refresh on unauthenticated calls, RFC 7807 mapping,
  network-failure → status 0, 204 handling.
- `src/auth/__tests__/session.test.ts` (6) — save/load round-trip, corrupt
  and wrong-shaped data → null, clear, token-rotation overwrite.
- `src/auth/__tests__/AuthProvider.test.tsx` (5) — cold start
  unauthenticated; sign-in persists + surfaces user; fresh provider restores
  via `GET /v1/me`; sign-out revokes + clears; sign-out clears even when
  revocation fails.
- `src/components/__tests__/Button.test.tsx` (4) — press, disabled, loading
  spinner + blocked press, accessibility state.
- `src/screens/__tests__/LoginScreen.test.tsx` (6) — empty/invalid input
  validation without API calls, error clearing on edit, correct login
  payload, 401 banner, connectivity message.
- `src/utils/__tests__/validation.test.ts` (19) — email/password/display-name
  rules mirroring the API contracts.
- `src/api/__tests__/live/auth.live.test.ts` (3, explicit) — real register,
  wrong-password 401, login → me → refresh → logout → revoked-token 401.

## Known issues / notes

1. **Expo Go will not run this app.** `expo-secure-store` and
   `expo-splash-screen` contain native code, so a development build
   (`npx expo run:android` / `run:ios`, or EAS) is required — per
   `apps/mobile/AGENTS.md`. Expo Go lacks those modules.
2. **No Android SDK / emulator in this sandbox**, so `expo run:android`
   was not executed here. Production JS bundles for both platforms were
   verified via `expo export` instead; native compilation happens on the
   developer's machine or EAS.
3. **jest-expo replaces global `fetch`** with a stubbed Expo winter
   polyfill (`FetchResponse` with `status: undefined`). The live suite
   therefore uses the node environment and its own `http`-module transport
   (`nodeHttpFetch`); the default suite injects fetch and is unaffected.
4. **`babel-preset-expo` went missing** from `node_modules` at one point
   (likely pruned by an `expo install` pass); reinstalled via
   `npx expo install babel-preset-expo`.
5. **SDK 57 removed the top-level `splash` key** from the app config
   schema — splash is now configured through the `expo-splash-screen`
   config plugin.
6. **tsconfig needs explicit `"types": ["jest", "node"]`** — without it,
   `tsc` could not see jest globals under the extended Expo base config.
7. **Same-second refresh yields a byte-identical access JWT** (claims are
   second-granularity). Expected; the opaque refresh token always rotates.
8. **"Waveform" branding is provisional** — chosen during implementation,
   not specified by the user. App name/slug/scheme/bundle ID
   (`com.musicstreaming.waveform`) are easy to rename before release.
9. `apps/mobile` is a **standalone package, not a root npm workspace**
   (own lockfile), matching the existing `apps/*` precedent and keeping the
   native toolchain out of the backend's install/lint/test lifecycle.
10. Root `npm test` (Vitest) was not re-run: nothing under `services/`,
    `packages/`, or `workers/` changed in this phase.

## Stopping point

Phase 5 is complete. Phase 6 (whatever it defines — catalog, player, etc.)
is **not started**.
