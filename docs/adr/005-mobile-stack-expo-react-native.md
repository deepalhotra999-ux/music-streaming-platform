# 005. Mobile stack: Expo (React Native + TypeScript)

Date: 2026-09-21
Status: accepted

## Context

ARCHITECTURE.md §1 recommended fully native clients (Swift/SwiftUI for iOS,
Kotlin/Jetpack Compose for Android), citing background audio, lock-screen /
remote-command integration, CarPlay, and Android Auto as the reasons native
was required.

For Phase 5 (Mobile Foundation) the project owner explicitly directed
**React Native + TypeScript** for iOS + Android, with this scope: navigation,
a design-system foundation, placeholder screens, and real authentication
against the Phase 4 API. Audio playback, HLS, CarPlay, and Android Auto are
explicitly out of scope for this phase.

## Decision

Build the mobile client as a single **Expo (React Native + TypeScript)** app
at `apps/mobile`, as a standalone npm package inside the existing monorepo
(own `package.json` + lockfile, not an npm workspace — matching the existing
`apps/*` precedent; see Consequences).

- One codebase ships iOS and Android from the start; the Phase 5 scope
  (auth, navigation, design system, placeholders) has no platform-specific
  audio or CarPlay requirements that would force native code today.
- Expo's managed workflow keeps native build complexity out of the repo:
  no Xcode/Gradle projects to maintain for the foundation, `expo-secure-store`
  covers Keychain/Keystore-backed token storage, and `expo export` produces
  verifiable production JS bundles without native SDKs in CI.
- TypeScript throughout matches the monorepo's language decision (ADR-001).
- Navigation via **Expo Router** (file-based routing built on React Navigation):
  routes live in `src/app/`; a root layout provides session state and
  redirects between the `(auth)` stack and the `(tabs)` navigator.
- The backend contract is unchanged: the app talks only to `services/api`
  over REST (`/v1/...`) with short-lived Bearer access tokens and rotating
  refresh tokens; the reusable API client lives in the app, not in
  `packages/contracts`, until a generated client is justified.

## Consequences

- `apps/ios` and `apps/android` remain as documented native placeholders;
  if a future phase needs CarPlay, Android Auto, or background-audio work
  that Expo cannot cover, the team can eject/prebuild or revisit native —
  that decision and its cost will be recorded in its own ADR.
- The app must never trust client-side claims for entitlements; premium
  status remains backend-owned (unchanged from ARCHITECTURE.md §1).
- `apps/mobile` is a standalone npm package inside the monorepo (own
  `package.json` + lockfile), **not** an npm workspace — matching the
  existing precedent that `apps/*` stay out of the JS workspaces
  (`apps/ios` and `apps/android` READMEs). This keeps the mobile native
  toolchain isolated from the backend's install/test/lint lifecycle.
- Auth tokens are stored only in `expo-secure-store` (never AsyncStorage,
  never in code); logout revokes the refresh token server-side and clears
  local storage unconditionally.
- No audio, HLS, player, search, playlist, subscription, or payment code in
  Phase 5 — placeholders only, so the native-module surface stays minimal.
