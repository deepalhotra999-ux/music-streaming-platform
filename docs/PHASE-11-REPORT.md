# Phase 11 Report — Library + Playlists

Date: 2026-09-21
Base: `fc04e9f` (Phase 10)
Status: complete, untested on physical hardware (see limitations)

## What was built

The authenticated user's Library and playlist-management experience, built
on the existing Phase 4 backend (no backend changes) and played through the
existing Phase 8/9 `PlaybackEngine` — no second playback system:

1. **Library API layer** (`apps/mobile/src/api/library.ts`)
   - Likes: `listLikedTracks`, `likeTrack`, `unlikeTrack`
     (`GET/POST/DELETE /v1/me/likes`).
   - Follows: `listFollowedArtists`, `followArtist`, `unfollowArtist`
     (`/v1/me/follows`).
   - History: `listHistory` (`/v1/me/history`).
   - Owned playlists: `listMyPlaylists` (`/v1/me/playlists`).
   - Playlist mutations: `createPlaylist`, `updatePlaylist`,
     `deletePlaylist`, `addTrackToPlaylist`, `movePlaylistItem`,
     `removePlaylistItem` (owner-only endpoints; the backend keeps
     returning 404 to non-owners, so private playlists stay protected).

2. **Library state** (`apps/mobile/src/library/`)
   - `LibraryContext` (`LibraryProvider`): bootstraps liked-track and
     followed-artist id sets (paginated), exposes optimistic
     `toggleLike`/`toggleFollow` with rollback + rethrow on API failure.
   - Mounted inside the authenticated `PlaybackProvider` in
     `app/_layout.tsx`; state resets on sign-out via shell unmount.
   - `LikeButton` / `FollowButton` components with immediate visual state;
     `PlaylistForm` (title + visibility) with server-error display;
     `LibraryList` wrapper over the catalog's paginated list with
     loading/empty/error/retry states; `format.ts` helpers.

3. **Screens & routes** (all under the authenticated `(catalog)` stack)
   - `LibraryScreen` (tab home): independent previews for liked tracks,
     recently played, my playlists, followed artists, and public
     playlists — each with its own loading/empty/error/retry state,
     plus an inline create-playlist form and drill-down navigation.
   - `LikedTracksScreen`, `RecentlyPlayedScreen`, `MyPlaylistsScreen`,
     `FollowedArtistsScreen`: full paginated lists; tap-to-play from the
     tapped position and long-press to queue via `useQueueActions`.
   - `PlaylistDetailScreen`: owner detection via `playlist.ownerUserId`
     vs the authenticated user id. Everyone can play/queue/like;
     owner-only controls for rename, delete, add/remove/reorder tracks.
     Reordering moves up/down by swapping adjacent absolute positions
     (two sequential position updates, then reload).
   - `AddTracksScreen` (`add-tracks/[playlistId]`): paginated catalog
     track browser with a debounced `q` filter (browsing with a filter,
     not the out-of-scope Search product); seeds already-added ids from
     the playlist detail; optimistic add with rollback + alert on failure.
   - `ArtistDetailScreen`: gained a `FollowButton`.
   - "Followed/public playlists" is satisfied by displaying existing
     public playlists — there is no playlist-follow endpoint, and none
     was invented.

## Acceptance criteria

- [x] Liked tracks list with immediate like/unlike state.
- [x] Recently played list with relative timestamps.
- [x] User playlists list; create, rename, delete.
- [x] Add/remove/reorder tracks in owned playlists.
- [x] Open a playlist and play it through the existing `PlaybackEngine`.
- [x] Add tracks to the existing queue (no second playback system).
- [x] Follow/unfollow artists where supported.
- [x] Loading, empty, error, retry states on every section.
- [x] Pagination where supported.
- [x] Auth boundaries: private playlists 404 for non-owners (verified
      live); owner-only UI gated on `ownerUserId === user.id`.
- [x] Mini/full player and Phase 10 background behavior untouched.
- [x] Out-of-scope items (search product, AI, payments, uploads,
      royalties, CarPlay/Android Auto, offline, social) not built.

## Tests

- Mobile unit: **267/267 pass, 33 suites** (`npx jest`).
  - New: `api/__tests__/library.test.ts` (paths/methods/bodies/
    pagination), `library/__tests__/LibraryContext.test.tsx` (13:
    bootstrap, multi-page bootstrap, optimistic toggles, rollback,
    failed bootstrap) + `format.test.ts`, `screens/__tests__/`:
    `LibraryScreen`, `PlaylistDetailScreen` (9), `LikedTracksScreen`,
    `MyPlaylistsScreen`, `LibrarySections` (followed-artists +
    recently-played, 4), `AddTracksScreen` (5: already-added seeding,
    successful add, rollback/alert on failure, debounced `q` filter,
    pagination).
  - Existing suites (incl. `ArtistDetailScreen`, catalog, player)
    unaffected — 33/33 suites green.
- Live API: **19/19 pass, 5 suites** (`npm run test:live`), including the
  new `library.live.test.ts` (7/7): like/unlike, follow/unfollow,
  playlist create → add 2 tracks → reorder (two-step position swap) →
  remove → rename, private playlist 404 for anonymous readers,
  playback-session creation for a playlist track (Play integration),
  liked-list pagination + history read. Test user/playlist/likes/follows
  cleaned up in `afterAll`.
- Backend tests: not run — no backend code changed.
- `tsc --noEmit`: clean. `eslint src`: clean. `expo-doctor`: 21/21.
- `expo export --platform android` and `--platform ios`: both green
  (generated `dist/` removed afterwards, as in prior phases).

## Manual checklist

- [x] Library → create playlist → add tracks → open playlist → play
      verified against the real API (live test, incl. HLS session).
- [x] Two-step position swap verified against the real API (no
      uniqueness-constraint failure).
- [x] Dev audio generated for the fresh sandbox DB so the playback
      session path could be exercised live (`npm run audio:generate`).
- [x] API server and Prisma mirror stopped; live-test data cleaned up.
- [ ] Physical device run (no device/SDK in sandbox — same standing
      limitation as Phases 8–10).

## Known issues / limitations

- `LibraryScreen` pull-to-refresh ends its spinner on a 500 ms timeout
  instead of awaiting all section reloads (cosmetic).
- `LibraryContext` optimistic toggles snapshot the current sets; rapid
  concurrent taps on the same item are not specifically hardened.
- Add-track picker silently ignores a failed playlist-detail seed and
  relies on backend duplicate protection.
- Reordering does two sequential position updates then reloads (verified
  working against the real API, but not atomic).
- Not physically tested: no Android SDK, emulator, macOS/Xcode, or
  device in the sandbox — mini/full player taps, background behavior
  with the new screens, and tab-bar layout are unverified on hardware.
- Sandbox-only: this VM arrived without Postgres; it was rebuilt via the
  `pgserver` recipe in `~/TOOLS.md` (PG 16.2 + hand-compiled citext),
  role `music`, DBs `musicdb`/`musicdb_test` migrated + seeded. Normal
  machines use docker-compose per the repo docs.

## Files created

- `apps/mobile/src/api/library.ts`
- `apps/mobile/src/api/__tests__/library.test.ts`
- `apps/mobile/src/api/__tests__/live/library.live.test.ts`
- `apps/mobile/src/library/LibraryContext.tsx`
- `apps/mobile/src/library/format.ts`
- `apps/mobile/src/library/index.ts`
- `apps/mobile/src/library/components/LikeButton.tsx`
- `apps/mobile/src/library/components/FollowButton.tsx`
- `apps/mobile/src/library/components/PlaylistForm.tsx`
- `apps/mobile/src/library/components/LibraryList.tsx`
- `apps/mobile/src/library/__tests__/LibraryContext.test.tsx`
- `apps/mobile/src/library/__tests__/format.test.ts`
- `apps/mobile/src/app/(catalog)/liked-tracks.tsx`
- `apps/mobile/src/app/(catalog)/recently-played.tsx`
- `apps/mobile/src/app/(catalog)/my-playlists.tsx`
- `apps/mobile/src/app/(catalog)/followed-artists.tsx`
- `apps/mobile/src/app/(catalog)/add-tracks/[playlistId].tsx`
- `apps/mobile/src/screens/LikedTracksScreen.tsx`
- `apps/mobile/src/screens/RecentlyPlayedScreen.tsx`
- `apps/mobile/src/screens/MyPlaylistsScreen.tsx`
- `apps/mobile/src/screens/FollowedArtistsScreen.tsx`
- `apps/mobile/src/screens/AddTracksScreen.tsx`
- `apps/mobile/src/screens/__tests__/LibraryScreen.test.tsx`
- `apps/mobile/src/screens/__tests__/PlaylistDetailScreen.test.tsx`
- `apps/mobile/src/screens/__tests__/LikedTracksScreen.test.tsx`
- `apps/mobile/src/screens/__tests__/MyPlaylistsScreen.test.tsx`
- `apps/mobile/src/screens/__tests__/LibrarySections.test.tsx`
- `apps/mobile/src/screens/__tests__/AddTracksScreen.test.tsx`
- `docs/PHASE-11-REPORT.md`

## Files modified

- `apps/mobile/src/api/types.ts` (library types)
- `apps/mobile/src/api/index.ts` (library exports)
- `apps/mobile/src/app/_layout.tsx` (LibraryProvider inside auth shell)
- `apps/mobile/src/app/(catalog)/_layout.tsx` (new routes)
- `apps/mobile/src/screens/index.ts` (screen exports)
- `apps/mobile/src/screens/LibraryScreen.tsx` (full rewrite: sections)
- `apps/mobile/src/screens/PlaylistDetailScreen.tsx` (owner controls)
- `apps/mobile/src/screens/ArtistDetailScreen.tsx` (FollowButton)
- `apps/mobile/jest.setup.js` (useFocusEffect mock)

No backend files changed; no ADR needed (no new architectural decision —
the backend contract and auth model are unchanged).
