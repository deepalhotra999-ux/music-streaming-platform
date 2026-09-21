# Phase 12 Report — Search & Discovery

Date: 2026-09-21
Base: `e436ce2` (Phase 11)
Status: complete, untested on physical hardware (see limitations)

## What was built

The authenticated user's Search and basic discovery experience, on the
existing Phase 4 backend (**no backend changes**) and played through the
existing Phase 8/9 `PlaybackEngine` — no second playback system, no
recommendations, no AI:

1. **Search API layer** (`apps/mobile/src/search/api.ts`)
   - `searchCatalog(client, query, { limitPerCategory })`: one debounced
     query fans out to five parallel Phase 4 `q` filters —
     `listArtists`, `listAlbums`, `listTracks`, `listGenres`,
     `listPublicPlaylists` — and returns categorized results with
     backend totals. Ordering, visibility, and auth stay server-side;
     the client only forwards `q`.
   - Privacy: playlists are searched through `/v1/playlists/public`
     only. There is no code path that can reach owned/private
     playlists, so private playlists can never surface in results
     regardless of the viewer's token (verified live).

2. **Recent searches** (`apps/mobile/src/search/recents.ts`)
   - Device-local AsyncStorage (`waveform.search.recents.v1`),
     most-recent-first, case-insensitive de-dupe, capped at 10,
     corrupt JSON degrades to an empty list. Never sent to the
     backend; not synced; sign-out does not move them.
   - `recordSearch` / `removeRecentSearch` / `clearRecentSearches` /
     `loadRecentSearches`; storage is injectable for tests.

3. **Hooks** (`apps/mobile/src/search/hooks.ts`)
   - `useDebouncedValue(value, 300ms)` — shared debounce primitive
     (extracted from the AddTracksScreen pattern).
   - `useSearch(client, query)` — idle → loading → ready/error state
     machine over the debounced query; a generation counter discards
     stale responses; `retry()` re-issues the same debounced query.

4. **Components** (`apps/mobile/src/search/components/`)
   - `SearchBar` (search icon, clear button, search return key),
     `RecentSearches` (re-run on tap, per-item ✕, Clear all),
     `SearchResults` (one section per non-empty category with
     result-type header + backend total; reuses `ArtistRow`,
     `AlbumRow`, `TrackRow`, `PlaylistRow`; local `GenreRow` since
     the catalog kit only ships a `GenreCard`).

5. **SearchScreen** (full rewrite of the Phase 5 placeholder)
   - Empty query: recent searches, or an empty state when there are
     none. Typing: loading → categorized results → per-category
     empty ("No results for …"), full error + retry, pull-to-refresh.
   - Artist/album/genre/playlist taps open the existing detail
     routes; track tap plays through `useQueueActions`
     (`playTracks(tracks, index)`); track long-press appends to the
     queue (`addToQueue`). Result selections are recorded as recent
     searches.

6. **Discovery/Home**: no changes. Home already provides five
   API-backed discovery sections (New releases, Artists, Recently
   added tracks, Featured playlists, Browse genres) with per-rail
   states; per the brief ("only where necessary") nothing was
   invented, and no fake personalization was added — the backend
   supports none, so none is shown.

## Acceptance criteria

- [x] Functional search replaces the placeholder tab.
- [x] Searches artists, albums, tracks, genres, public playlists.
- [x] Debounced input (300 ms).
- [x] Categorized results with clear result types + totals.
- [x] Tapping artist/album/playlist opens the existing detail screen.
- [x] Tapping a track plays it via the existing PlaybackEngine.
- [x] Long-pressing a track adds it to the existing queue.
- [x] Empty, loading, error, and retry states.
- [x] Recent searches on-device; remove one / clear all.
- [x] Library, player, queue, shuffle, repeat, background playback
      untouched (all existing suites still green).
- [x] Design system + catalog components reused.
- [x] Auth boundaries intact (private playlists unsearchable).
- [x] No AI/recommendations/ML ranking/payments/uploads/royalties/
      CarPlay/Android Auto/offline/social/commerce.

## Tests

- Mobile unit: **301/301 pass, 38 suites** (`npx jest`) — 267 before,
  34 new:
  - `search/__tests__/recents.test.ts` (8): persistence, ordering,
    de-dupe, cap, empty-query ignore, single remove, clear-all,
    corrupt-JSON degradation.
  - `search/__tests__/api.test.ts` (6): five-endpoint fan-out with
    `q` + default/custom limit, categorization with backend totals,
    empty-query rejection without network, error propagation,
    public-playlist-only privacy boundary.
  - `search/__tests__/hooks.test.tsx` (7): debounce coalescing and
    timer reset, idle on empty query, idle→loading→ready, error→retry,
    stale-response disposal, return to idle on clear.
  - `search/__tests__/SearchResults.test.tsx` (4): section headers +
    totals, empty categories omitted, press routing per row type.
  - `screens/__tests__/SearchScreen.test.tsx` (9): empty state,
    debounced search rendering, no-results, error + retry, artist
    tap → `router.push('/artist/a1)` + recent recorded, track tap →
    `playTracks(tracks, 0)` with no navigation, long-press →
    `addToQueue`, recent re-run / single remove / clear-all.
- Live API: **27/27 pass, 6 suites** (`npm run test:live`), including
  the new `search.live.test.ts` (8/8) against seeded data: artist,
  album, track, genre hits; case-insensitivity; empty categories for
  nonsense queries; seeded PRIVATE playlist ("Mia's Focus Mix")
  absent from anonymous search; fresh PRIVATE vs PUBLIC playlist —
  anonymous search finds the public one and not the private one.
  Test user/playlists deleted in `afterAll`.
- Backend tests: not run — zero backend changes (`git status`
  confirms nothing under `services/`).
- `tsc --noEmit`: clean. `eslint .`: clean. `expo-doctor`: 21/21.
- `expo export --platform android` and `--platform ios`: both green
  (generated `dist/` removed afterwards).

## Manual checklist

- [x] Real API search flow exercised end-to-end (live suite).
- [x] Private-playlist privacy verified against the real API
      (anonymous + owner-created private vs public).
- [x] Existing Library and player live suites still pass (19/19
      before, unchanged behavior).
- [x] Test data cleaned; API server and Prisma mirror stopped.
- [ ] Physical device run (no device/SDK in sandbox — same standing
      limitation as Phases 8–11).

## Known issues / limitations

- Search shows the top 5 results per category with no per-category
  "see all" page; the existing filtered catalog lists (artists,
  albums, tracks) already offer full filtered browsing.
- `q` is substring matching (backend `contains`), not tokenized
  full-text search: multi-word queries must appear contiguously.
  This is the existing Phase 4 filter semantic, unchanged.
- Recent searches are device-local and not cleared on sign-out (by
  design — they contain no account data).
- Not physically tested: no Android SDK, emulator, macOS/Xcode, or
  device in the sandbox — search typing, taps, and layout are
  unverified on hardware.
- Sandbox-only: this VM arrived with Postgres already running from a
  prior session (pgserver recipe in `~/TOOLS.md`); role `music`, DBs
  `musicdb`/`musicdb_test` migrated + seeded. Normal machines use
  docker-compose per the repo docs.

## Decisions

- **No backend search endpoint.** All five list endpoints already
  support case-insensitive `q` with the standard paginated envelope;
  a unified `/v1/search` would save round trips but add no
  capability the brief's "genuinely requires" bar demands. Five
  parallel requests it is — backend untouched since Phase 7.
- **No Home changes.** The five existing sections already provide
  basic discovery entry points over real catalog data; inventing
  "recommended for you" without backend support would be fake
  personalization, explicitly excluded.
- **AsyncStorage for recents** (`@react-native-async-storage/
  async-storage`, installed via `npx expo install`) — the
  Expo-recommended store for non-secret device-local data;
  `expo-secure-store` remains reserved for credentials/session.
- No ADR: no new architectural decision — the backend contract,
  auth model, and playback architecture are unchanged.

## Files created

- `apps/mobile/src/search/types.ts`
- `apps/mobile/src/search/api.ts`
- `apps/mobile/src/search/recents.ts`
- `apps/mobile/src/search/hooks.ts`
- `apps/mobile/src/search/index.ts`
- `apps/mobile/src/search/components/SearchBar.tsx`
- `apps/mobile/src/search/components/RecentSearches.tsx`
- `apps/mobile/src/search/components/SearchResults.tsx`
- `apps/mobile/src/search/__tests__/recents.test.ts`
- `apps/mobile/src/search/__tests__/api.test.ts`
- `apps/mobile/src/search/__tests__/hooks.test.tsx`
- `apps/mobile/src/search/__tests__/SearchResults.test.tsx`
- `apps/mobile/src/search/__tests__/live/search.live.test.ts`
- `apps/mobile/src/screens/__tests__/SearchScreen.test.tsx`
- `docs/PHASE-12-REPORT.md`

## Files modified

- `apps/mobile/src/screens/SearchScreen.tsx` (full rewrite: functional search)
- `apps/mobile/package.json` + `package-lock.json` (added
  `@react-native-async-storage/async-storage`)
- `apps/mobile/jest.setup.js` (in-memory AsyncStorage mock)

No backend files changed.
