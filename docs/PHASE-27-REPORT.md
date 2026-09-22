# Phase 27 Report — Collaborative Playlists

**Date:** 2026-09-22
**Baseline:** `f390989` (Phase 26: AI music discovery)
**Status:** Complete, verified, documented, committed (`9a9f33f`).
Stopped at the phase boundary — Phase 28 was not started.

## What was built

**Backend** (`services/api/src/modules/playlists/`):

- Collaboration schema: `Playlist.isCollaborative` (default `false`),
  `Playlist.revision` (default `0`), `CollaboratorRole` (`OWNER`|`EDITOR`),
  `PlaylistMember` (composite PK), `PlaylistInvitation` (SHA-256
  token-hash-only, 7-day expiry, single-use, revocable),
  `PlaylistChange` (append-only history with a DB trigger rejecting
  `UPDATE`/`DELETE`).
- Migration `20260922152249_phase27_collab` — Phase 27-only, applied to
  `musicdb` and `musicdb_test`.
- Optimistic concurrency: collaborative track mutations require
  `expectedRevision`; the revision bump is an atomic compare-and-swap
  inside the mutation transaction. Stale writes get RFC 7807 409 and
  never land. The new revision is returned in the `x-playlist-revision`
  header.
- Invitation flow: 256-bit base64url tokens, raw token returned exactly
  once on create, hash-only storage, single-use atomic claim on accept.
- Existence-hiding 404s for non-members on all membership-gated
  resources, consistent with the Phase 4 private-playlist convention.
- Membership and history identities come from the auth session, never
  client fields; unknown JSON properties are stripped by validation.
- Collaboration grants no playback entitlement; private collaborative
  data never leaks through search, discovery, public listings, or
  analytics.

**Mobile** (`apps/mobile/`):

- Owner collaboration toggle, member list, create/share one-time
  invitation, paste/accept invitation, leave/remove member.
- Collaborative badges and editor indicators; viewer-role-gated track
  controls.
- Revision tracking per playlist; on 409 the client refetches and shows
  "updated by a collaborator", rolling back the failed optimistic change.
- Collaborative editing disabled while offline; Phase 25 offline
  downloads/playback unchanged; single shared `PlaybackEngine`; no
  collaborative editing UI in CarPlay/Android Auto.

**Docs:** `docs/adr/021-collaborative-playlists.md` (concurrency,
membership, invitation security decisions), `docs/COLLABORATIVE-PLAYLISTS.md`
(data model, permission matrix, API, concurrency, privacy, limitations),
`docs/PHASE-27-REPORT.md` (this file).

## Acceptance criteria

- [x] Owner can enable/disable collaboration; editors can add/remove/reorder tracks.
- [x] Stale collaborative writes return RFC 7807 409 and never silently overwrite.
- [x] Invitations are single-use, expiring, revocable, hash-only.
- [x] Change history is append-only at the DB level.
- [x] Private collaborative playlists are invisible to non-members everywhere.
- [x] No WebSockets, presence, synchronized listening, chat, notifications,
      or in-car collaborative editing.
- [x] Phase 28 was not started.

## Tests

- Backend Phase 27 suite: **80/80** (`tests/phase27.test.ts`).
- Backend full suite: **478/478**, 15 files, exit 0 (the known pre-existing
  analytics UTC-day failure was not observed in this run; it was left
  untouched per protocol).
- Backend TypeScript: exit 0. Backend build: exit 0.
- Mobile full suite: **86 suites, 656/656 tests pass**
  (`npm test -- --runInBand`). Mobile TypeScript: clean. ESLint on all
  changed mobile files: clean. Prettier: applied to all changed mobile files.
  No Android SDK/device in sandbox — not physically tested.
- Mobile TypeScript: exit 0. Mobile ESLint: exit 0.
- Admin full suite: **36/36**, 8 files, exit 0. Admin TypeScript: exit 0.
  Admin build: exit 0.
- Expo Doctor: 20/21 — the one failure is the pre-existing direct
  `expo-modules-core` dependency warning, unchanged from prior phases
  (verified 2026-09-22).
- Android export: exit 0. iOS export: exit 0.
- Secret scan: no matches. Music/audio generation scan: no matches.

## Manual checklist

- [ ] Real device: collaboration toggle, invite share/accept flow,
      member list, leave/remove, conflict refresh on 409, offline
      editing disabled.
- [ ] Accessibility pass with screen reader on device.
- [ ] No production-readiness claim until the above are evidenced.

## Honest limitations

- No real-time sync: collaborators see changes only on refetch; the
  revision protocol is designed to be compatible with a future push
  layer without contract changes.
- Invitation delivery is out of band (no email/push); the owner shares
  the token.
- History grows monotonically; retention is a future ops decision.
- No physical device testing was performed in this sandbox.

## Files created

- `services/api/src/modules/playlists/collab.ts`
- `services/api/tests/phase27.test.ts`
- `services/api/prisma/migrations/20260922152249_phase27_collab/migration.sql`
- `apps/mobile/src/api/collab.ts`
- `apps/mobile/src/api/__tests__/collab.test.ts`
- `apps/mobile/src/library/useCollabMutations.ts`
- `apps/mobile/src/library/__tests__/useCollabMutations.test.ts`
- `apps/mobile/src/library/components/CollaborativeBadge.tsx`
- `apps/mobile/src/library/components/__tests__/CollaborativeBadge.test.tsx`
- `apps/mobile/src/utils/useOnlineStatus.ts`
- `apps/mobile/src/utils/__tests__/useOnlineStatus.test.tsx`
- `apps/mobile/src/screens/PlaylistMembersScreen.tsx`
- `apps/mobile/src/screens/AcceptInvitationScreen.tsx`
- `apps/mobile/src/screens/__tests__/PlaylistMembersScreen.test.tsx`
- `apps/mobile/src/screens/__tests__/AcceptInvitationScreen.test.tsx`
- `apps/mobile/src/app/(catalog)/invitation.tsx`
- `apps/mobile/src/app/(catalog)/playlist/[id]/members.tsx`
- `docs/adr/021-collaborative-playlists.md`
- `docs/COLLABORATIVE-PLAYLISTS.md`
- `docs/PHASE-27-REPORT.md`

## Files modified

- `services/api/prisma/schema.prisma`
- `services/api/src/modules/playlists/service.ts`
- `services/api/src/modules/playlists/schemas.ts`
- `services/api/src/modules/playlists/routes.ts`
- `apps/mobile/package.json`, `apps/mobile/package-lock.json` (expo-clipboard ~57.0.2)
- `apps/mobile/src/api/client.ts`, `src/api/index.ts`, `src/api/types.ts`
- `apps/mobile/src/api/__tests__/client.test.ts`
- `apps/mobile/src/app/(catalog)/_layout.tsx`
- `apps/mobile/src/library/index.ts`
- `apps/mobile/src/screens/AddTracksScreen.tsx`
- `apps/mobile/src/screens/MyPlaylistsScreen.tsx`
- `apps/mobile/src/screens/PlaylistDetailScreen.tsx`
- `apps/mobile/src/screens/index.ts`
- `apps/mobile/src/screens/__tests__/AddTracksScreen.test.tsx`
- `apps/mobile/src/screens/__tests__/MyPlaylistsScreen.test.tsx`
- `apps/mobile/src/screens/__tests__/PlaylistDetailScreen.test.tsx`
- `apps/mobile/src/search/__tests__/SearchResults.test.tsx`
- `apps/mobile/src/carplay/__tests__/contentProvider.test.ts`
- `apps/mobile/src/androidauto/__tests__/contentProvider.test.ts`

## Physical-test gaps

No physical device was available in this sandbox. Collaboration flows,
conflict refresh, offline gating, and accessibility are unproven on
hardware.
