# Phase 6 Report — Music Catalog

Date: 2026-09-21
Status: **complete** (stopping here per phase discipline; Phase 7 not started)

## Scope delivered

The mobile app is now connected to the existing Phase 4 catalog APIs. The
Fastify backend was **not modified** — the app uses the published contracts
only and duplicates no backend logic (no filtering, ordering, or visibility
rules in the client). Explicitly excluded per the brief: audio playback,
HLS, mini/full player, background audio, offline downloads, subscriptions,
payments, CarPlay, recommendations, AI, artist uploads.

- **API layer** — `src/api/catalog.ts`: thin wrappers over the Phase 4
  routes (`GET /v1/artists`, `/v1/artists/:id`, `/v1/albums`,
  `/v1/albums/:id`, `/v1/tracks`, `/v1/genres`, `/v1/genres/:id`,
  `/v1/playlists/public`, `/v1/playlists/:id`). Query strings are built with
  `URLSearchParams` from typed filter params. `src/api/types.ts` gained the
  catalog domain types (`Page`/`PageInfo`, artist/album/track/genre/playlist
  list and detail shapes).
- **Catalog UI kit** — `src/catalog/`: `ArtworkImage` (remote URL when
  present, deterministic procedural development-only placeholder otherwise —
  hue from the entity id, title initial; no copyrighted or network artwork),
  `SectionHeader`, `AlbumCard`/`ArtistCard`/`PlaylistCard`/`GenreCard`
  (rail and 2-col grid layouts), `TrackRow`/`AlbumTrackRow`/`ArtistRow`/
  `AlbumRow`/`PlaylistRow`, `CatalogListScreen` (generic paginated list:
  initial loading, empty, full error/retry, pull-to-refresh, load-more
  spinner/error, optional grid/search header), `usePaginatedList` and
  `useCatalogDetail` hooks, and `format.ts` (durations, release year,
  pluralized counts).
- **Home** — real API-backed sections with independent loading/error/empty
  states per rail: New releases, Artists, Recently added tracks, Featured
  playlists, Browse genres (2-col grid). Parallel fetch, pull-to-refresh,
  "See all" routes. Track taps navigate to the track's album (or artist).
- **Lists** — Artists, New releases (albums), Tracks (with optional
  artist/genre filters), Genres (2-col grid), Featured playlists; all
  paginated via the shared list screen, with search on artists/albums/tracks.
- **Details** — Artist profile (avatar, verified badge, bio, album/track/
  follower counts, albums rail, top tracks + see-all to the filtered track
  list), Album detail (cover, tappable artist link, type/year/track/duration
  meta, embedded track list in track-number order), Genre detail (header +
  paginated genre-filtered tracks), Public playlist detail (cover,
  description, owner, ordered items).
- **Routes** — new `(catalog)` Expo Router stack (themed headers, back
  navigation, no tab bar): `/artists`, `/artist/[id]`, `/albums`,
  `/album/[id]`, `/tracks` (+ optional `artistId`/`artistName`/`genreId`
  params), `/genres`, `/genre/[id]`, `/playlists`, `/playlist/[id]`. Added
  to the authenticated `Stack.Protected` guard in the root layout, so auth
  gating and tab navigation are unchanged.
- **Artwork** — seed `coverArtUrl`/`imageUrl` fields are null; the app shows
  generated placeholder art derived from each entity. When real artwork URLs
  ship, `ArtworkImage` already loads them.
- **States** — loading, empty, error/retry on every screen; per-rail
  isolation on Home and on the artist detail so one failing request never
  hides the rest.

## Acceptance criteria → results

| Criterion | Result |
|---|---|
| Connect mobile app to existing Phase 4 catalog APIs | ✅ thin wrappers, real HTTP |
| Use existing API contracts; no duplicated backend logic | ✅ client sends filters only; ordering/visibility stay server-side |
| Home catalog sections | ✅ 5 API-backed rails |
| Artist list + artist profile | ✅ list + detail w/ albums rail + top tracks |
| Album list + album detail | ✅ list + detail w/ embedded tracks |
| Track list | ✅ paginated, artist/genre filterable |
| Genre browsing | ✅ grid + detail with filtered tracks |
| Public playlist browsing | ✅ browse + detail (public only) |
| Track/album/artist artwork | ✅ URL when present; generated dev placeholder otherwise |
| Loading, empty, and error states | ✅ on every screen/rail |
| Pagination where appropriate | ✅ shared hook + list screen; artist/album/track/genre/playlist lists |
| Development/test music and artwork only | ✅ fictional seed catalog; procedural placeholder art |
| Existing Phase 5 design system; responsive iOS/Android | ✅ theme/components reused; exports for both platforms green |
| No playback/player/offline/subscriptions/payments/CarPlay/AI/uploads | ✅ none built |
| Mobile tests | ✅ 94 unit/component + 10 live (see Verification) |
| Typecheck, lint | ✅ `tsc --noEmit`, `eslint .` clean |
| Real API integration verified | ✅ live suite vs local Phase 4 API |
| Public catalog access without authentication | ✅ anonymous `ApiClient` (no token) hits all public endpoints incl. `GET /v1/playlists/:id` for public playlists |
| Authenticated navigation | ✅ auth live suite still green; `(catalog)` under `Stack.Protected` |
| Manual checklist | ✅ below |
| Known issues | ✅ below |
| All files reported | ✅ below |

## Verification (all green, 2026-09-21)

From `apps/mobile`:

- `npx jest` — 13 suites, **94 tests passed**
- `npm run test:live` (real Phase 4 API on localhost:3000) — 2 suites,
  **10 tests passed**:
  - `auth.live.test.ts` — Phase 5 regression: register/login/me/refresh/logout
  - `catalog.live.test.ts` (new): anonymous reads of artists/artists/:id,
    albums/albums/:id (with embedded tracks), paginated + artist-filtered
    tracks, genres/genres/:id, 404 on unknown artist; authenticated user
    creates a PUBLIC playlist with 2 tracks → anonymous
    `listPublicPlaylists` + `getPlaylist` see it → playlist deleted and
    verified 404 afterwards (no leftover test data)
- `npm run typecheck` (`tsc --noEmit`) — clean
- `npm run lint` (`eslint .`) — clean
- `npx expo-doctor` — 21/21 checks passed
- `npx expo export --platform ios` / `--platform android` — both succeed
  (route tree incl. the new `(catalog)` group bundles)
- `git status` — zero changes under `services/`, `packages/`, `workers/`;
  backend untouched

## Manual checklist

On a development build (Expo Go cannot run this app — native modules):

1. Log in, land on Home: five sections load (New releases, Artists,
   Recently added tracks, Featured playlists, Browse genres).
2. Tap "See all" on each section header → the matching list screen.
3. Open an artist → profile shows avatar placeholder, bio, counts, albums
   rail, tracks; "See all" on Tracks → filtered track list.
4. Open an album → cover, artist link (taps through), track list in order.
5. Open a genre → header + paginated track list for that genre.
6. Open a playlist → cover, owner, ordered tracks.
7. Airplane mode / kill the API → every screen shows an error state with
   "Try again"; Home rails fail independently with inline retry.
8. Pull-to-refresh on Home and on any list.
9. Scroll each list to the bottom → next page appends; spinner while loading.
10. Sign out → auth stack; sign in → tabs; catalog routes require auth
    (deep link to `/albums` while signed out lands on login).

## Known issues

- Seed artwork URLs are null, so all artwork is the generated placeholder
  (by design for Phase 6). Real URLs will render automatically via
  `ArtworkImage` when the backend provides them.
- `TrackRow` art is keyed by album/track id because the Phase 4 track list
  contract carries no `coverArtUrl`. No backend field was invented; if one
  is added later, rows can pass it through.
- Artist detail shows the artist's first 10 albums in a rail (no paginated
  "all albums by artist" screen yet — 10 covers the seed and typical
  catalogs).
- Search tab is still the Phase 5 placeholder; catalog search inputs exist
  on the artist/album/track lists only.
- No Android SDK/emulator in this sandbox, so the export was validated but
  the app was not run on a device here.

## Files created

- `apps/mobile/src/api/catalog.ts` — Phase 4 catalog endpoint wrappers
- `apps/mobile/src/catalog/format.ts` — duration/year/count/placeholder helpers
- `apps/mobile/src/catalog/hooks.ts` — `usePaginatedList`, `useCatalogDetail`
- `apps/mobile/src/catalog/index.ts` — public surface
- `apps/mobile/src/catalog/components/ArtworkImage.tsx`
- `apps/mobile/src/catalog/components/SectionHeader.tsx`
- `apps/mobile/src/catalog/components/Cards.tsx`
- `apps/mobile/src/catalog/components/Rows.tsx`
- `apps/mobile/src/catalog/components/CatalogListScreen.tsx`
- `apps/mobile/src/screens/HomeScreen.tsx` — replaced placeholder
- `apps/mobile/src/screens/ArtistListScreen.tsx`
- `apps/mobile/src/screens/ArtistDetailScreen.tsx`
- `apps/mobile/src/screens/AlbumListScreen.tsx`
- `apps/mobile/src/screens/AlbumDetailScreen.tsx`
- `apps/mobile/src/screens/TrackListScreen.tsx`
- `apps/mobile/src/screens/GenreListScreen.tsx`
- `apps/mobile/src/screens/GenreDetailScreen.tsx`
- `apps/mobile/src/screens/PlaylistListScreen.tsx`
- `apps/mobile/src/screens/PlaylistDetailScreen.tsx`
- `apps/mobile/src/app/(catalog)/_layout.tsx` — catalog stack
- `apps/mobile/src/app/(catalog)/artists.tsx`
- `apps/mobile/src/app/(catalog)/artist/[id].tsx`
- `apps/mobile/src/app/(catalog)/albums.tsx`
- `apps/mobile/src/app/(catalog)/album/[id].tsx`
- `apps/mobile/src/app/(catalog)/tracks.tsx`
- `apps/mobile/src/app/(catalog)/genres.tsx`
- `apps/mobile/src/app/(catalog)/genre/[id].tsx`
- `apps/mobile/src/app/(catalog)/playlists.tsx`
- `apps/mobile/src/app/(catalog)/playlist/[id].tsx`
- `apps/mobile/src/api/__tests__/catalog.test.ts` — contract/path tests
- `apps/mobile/src/api/__tests__/live/catalog.live.test.ts` — live API tests
- `apps/mobile/src/catalog/__tests__/format.test.ts`
- `apps/mobile/src/catalog/__tests__/hooks.test.tsx`
- `apps/mobile/src/catalog/components/__tests__/ArtworkImage.test.tsx`
- `apps/mobile/src/catalog/components/__tests__/Rows.test.tsx`
- `apps/mobile/src/catalog/components/__tests__/CatalogListScreen.test.tsx`
- `apps/mobile/src/screens/__tests__/HomeScreen.test.tsx`

## Files modified

- `apps/mobile/src/api/types.ts` — catalog domain types
- `apps/mobile/src/api/index.ts` — export catalog types/wrappers
- `apps/mobile/src/components/Screen.tsx` — optional safe-area `edges` prop
- `apps/mobile/src/app/_layout.tsx` — `(catalog)` added to authenticated guard
- `apps/mobile/src/app/(tabs)/_layout.tsx` — comment: Home is now the catalog
- `apps/mobile/src/screens/index.ts` — export new screens
- `apps/mobile/jest.setup.js` — router hooks mock, `@expo/vector-icons` stub

## Decisions

- **No backend changes** (consistent with Phases 4–5): pagination envelopes,
  ordering, and playlist visibility are consumed as-is; the client only
  forwards `page`/`limit`/filter params.
- **`(catalog)` stack beside `(tabs)`** rather than nested under a tab:
  detail/list screens get a native back button and no tab bar, matching
  platform conventions for drill-down navigation.
- **Independent rail failures on Home**: each section catches its own error
  so one down endpoint never blanks the home screen.
- **Album detail uses the embedded `tracks` array** from `GET /v1/albums/:id`
  (no extra request); playlist detail likewise uses embedded `items`.
- **Procedural placeholder art** instead of network placeholders: no
  external requests, no copyrighted images, deterministic per entity.
