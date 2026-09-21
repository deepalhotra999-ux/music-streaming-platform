# Phase 13 Report — Artist Platform Foundation

Date: 2026-09-21
Base: `ebc308a` (Phase 12)
Status: complete, untested on physical hardware (see limitations)

## What was built

An authenticated Artist area for approved `ARTIST` accounts, on the
existing Phase 4 backend (**no backend changes, no migration**) — the
Phase 4 artist/profile/album/track endpoints already enforce role checks
and `Artist.ownerUserId` ownership isolation, so the mobile work is a
thin, ownership-preserving client over them:

1. **Artist API layer** (`apps/mobile/src/api/artist.ts`)
   - Typed wrappers over the Phase 4 routes: `listMyArtists`,
     `createArtist`, `getArtist`, `updateArtist`, `deleteArtist`,
     `getArtistProfile`, `updateArtistProfile`, `listArtistAlbums`,
     `createAlbum`, `updateAlbum`, `deleteAlbum`, `listArtistTracks`,
     `createTrack`, `updateTrack`, `deleteTrack`, plus typed
     `CreateArtistInput` / `UpdateArtistProfileInput` /
     `AlbumInput` / `TrackInput` request shapes.
   - Track statuses are surfaced in the UI as Draft (`PROCESSING`),
     Published (`READY`), Failed (`FAILED`), Taken down (`TAKEDOWN`).
     The schema has no album publication status.

2. **Artist screens** (`apps/mobile/src/screens/`)
   - `ArtistDashboardScreen`: profile summary, published album/track
     counts, quick links; full loading/empty/error/retry states.
   - `ArtistProfileScreen`: view + edit own profile (name, bio,
     website, profile image URL, banner URL) using existing schema
     fields only; client-side validation; shared RFC 7807 error
     display.
   - `ArtistAlbumsScreen` / `ArtistTracksScreen`: paginated lists with
     create/edit/delete, album picker for tracks, track metadata and
     status badges.
   - First-run flow: an approved ARTIST with no artist row is offered
     identity creation; multiple owned artists can be switched.

3. **Navigation + role gating**
   - New `(artist)` Expo Router stack (`profile`, `albums`, `tracks`)
     and an `artist` tab that mounts only when
     `user.role === 'ARTIST'`.
   - Authenticated `LISTENER` and `ADMIN` users hitting `(artist)`
     deep links are redirected back to the tabs. No second
     authorization system: the backend remains authoritative.

4. **Tests**
   - Unit: API contract tests, four screen suites (12/12), tab-gating
     and layout tests.
   - Live: `artist.live.test.ts` (6/6) against the real API —
     ARTIST creation + `/v1/me/artists`, LISTENER write denial (403),
     profile update, album CRUD + validation, track draft→publish
     flow + duplicate-ISRC conflict (409), second-owner cross-artist
     writes returning 403, anonymous public catalog unaffected.
   - Role-promotion helper `services/api/scripts/set-user-role.mjs`
     (dev/test only, marked "never deploy" — role promotion is
     admin-only over HTTP; the helper writes the DB directly).

## Acceptance criteria

- [x] Authenticated Artist area exists for approved ARTIST accounts.
- [x] Dashboard: profile summary, published albums/tracks, counts.
- [x] Loading / empty / error / retry states on all artist screens.
- [x] Own profile editing with existing schema fields.
- [x] Own album and track CRUD via existing APIs.
- [x] Ownership isolation preserved (cross-owner writes → 403, live).
- [x] LISTENER gains no artist-management permissions (403, live).
- [x] ADMIN retains platform-wide backend management (Phase 4 suite
      green: admin user listing, role changes, artist verification).
- [x] Auth, authorization, pagination, API errors, navigation, and
      design system reused; no second authorization system.
- [x] No uploads, S3, transcoding, or copyrighted music.
- [x] Library, Search, Playback, catalog suites still green.

## Tests

- Mobile unit: **341/341 pass, 45 suites** (`npx jest`) — 301 before,
  40 new:
  - `api/__tests__/artist.test.ts`: request shapes, envelopes,
    error mapping for all artist/album/track/profile operations.
  - `screens/__tests__/ArtistDashboardScreen.test.tsx`,
    `ArtistProfileScreen.test.tsx`, `ArtistAlbumsScreen.test.tsx`
    (with `ArtistTracksScreen.test.tsx`: 12/12, 2 suites): loading,
    empty, error + retry, validation, create/edit/delete flows.
  - `app/(tabs)/__tests__/tabs.test.tsx`: artist tab mounts only for
    `ARTIST`; hidden for LISTENER/ADMIN.
  - `app/(artist)/__tests__/layout.test.tsx`: non-ARTIST deep links
    redirect to tabs.
- Live API: **33/33 pass, 7 suites** (mobile live config) against the
  real API, including the new `artist.live.test.ts` (6/6) covering the
  full ARTIST role/ownership flow listed above. Live-created
  artist/album/track rows are deleted in `afterAll`; an anonymous
  catalog search afterward returns no "Live Artist" content.
  Throwaway live-test *user* rows are not deleted (documented
  limitation).
- Backend: **100/100 pass, 5 suites** (`npx vitest run`) — Phase 2/3/4
  auth, rate-limit, and streaming suites, including the real ADMIN
  management flows (admin user listing + pagination, admin role
  change, non-admin rejection, admin artist verification,
  admin genre create/delete).
- Typecheck: `tsc --noEmit` clean (mobile + API).
- Lint: ESLint clean (mobile + API).
- Expo Doctor: **21/21 checks pass**.
- `expo export` for **ios** and **android**: both succeed.

## Manual checklist

- [ ] Sign in as an ARTIST on a physical device: dashboard shows
      profile summary and correct counts.
- [ ] Create/edit/delete an album and a track; verify lists update.
- [ ] Edit profile fields; verify the public artist page reflects them.
- [ ] Confirm the Artist tab is absent for LISTENER and ADMIN accounts.
- [ ] Confirm deep-linking to `(artist)` routes as LISTENER/ADMIN
      redirects to tabs.
- [ ] Rotate through loading/empty/error states (airplane mode) and
      retry.

## Known issues / limitations

- **No physical-device testing.** No Android SDK/emulator, macOS/Xcode,
  or physical device exists in this sandbox, so dev-build compile,
  on-device layout, navigation animations, and the artist flows above
  are unverified on hardware. Automated checks (tests, typecheck,
  lint, doctor, both exports) are green.
- Live-test throwaway **user** rows are not deleted; only their
  artist/album/track content is cleaned up.
- Track status labels (Draft/Published/Failed/Taken down) are a UI
  mapping over the `PROCESSING`/`READY`/`FAILED`/`TAKEDOWN` enum; there
  is no album publication status in the schema.
- The mobile Artist tab is ARTIST-only by design; ADMIN management
  stays on the backend (verified by the Phase 4 suite), not in the app.
- Environment note (sandbox-only): this run rebuilt local Postgres via
  the `pgserver` recipe in `~/TOOLS.md` (fresh VM had wiped it,
  including the hand-compiled `citext` extension). Normal machines use
  docker-compose / system Postgres and are unaffected.

## Decisions

- **No backend changes for Phase 13.** The Phase 4 API already had
  everything the artist area needs (role checks, ownership isolation,
  pagination, RFC 7807 errors). ADR-004 remains the auth model.
- **Backend authorization stays authoritative.** Client-side gating
  (ARTIST-only tab, deep-link redirects) is UX convenience; every
  mutation is re-checked server-side (proven live: cross-owner 403s).
- **ADMIN has no mobile artist tab.** ADMIN keeps platform-wide
  *backend* management; the dedicated artist surface is for ARTIST
  accounts only, per the brief.
- Track statuses get friendly UI labels; the enum itself is untouched.

## Files created

- `apps/mobile/src/api/artist.ts`
- `apps/mobile/src/api/__tests__/artist.test.ts`
- `apps/mobile/src/api/__tests__/live/artist.live.test.ts`
- `apps/mobile/src/artist/components/StatusBadge.tsx`
- `apps/mobile/src/artist/index.ts`
- `apps/mobile/src/screens/ArtistDashboardScreen.tsx`
- `apps/mobile/src/screens/ArtistProfileScreen.tsx`
- `apps/mobile/src/screens/ArtistAlbumsScreen.tsx`
- `apps/mobile/src/screens/ArtistTracksScreen.tsx`
- `apps/mobile/src/app/(artist)/_layout.tsx`
- `apps/mobile/src/app/(artist)/profile.tsx`
- `apps/mobile/src/app/(artist)/albums.tsx`
- `apps/mobile/src/app/(artist)/tracks.tsx`
- `apps/mobile/src/app/(tabs)/artist.tsx`
- `apps/mobile/src/app/(tabs)/__tests__/tabs.test.tsx`
- `apps/mobile/src/app/(artist)/__tests__/layout.test.tsx`
- `apps/mobile/src/screens/__tests__/ArtistDashboardScreen.test.tsx`
- `apps/mobile/src/screens/__tests__/ArtistProfileScreen.test.tsx`
- `apps/mobile/src/screens/__tests__/ArtistAlbumsScreen.test.tsx`
- `apps/mobile/src/screens/__tests__/ArtistTracksScreen.test.tsx`
- `services/api/scripts/set-user-role.mjs` (dev/test helper, never deploy)
- `docs/PHASE-13-REPORT.md` (this file)

## Files modified

- `apps/mobile/src/api/index.ts` (export artist API)
- `apps/mobile/src/app/(tabs)/_layout.tsx` (ARTIST-only tab)
- `apps/mobile/src/app/_layout.tsx` (register `(artist)` stack)
- `apps/mobile/src/screens/index.ts` (export artist screens)
- `apps/mobile/jest.setup.js` (test env for new suites)

## Phase 14

Not started, per the brief. Stopping here.
