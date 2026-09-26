# Phase 29 Report — Artist / Fan Community

**Date:** 2026-09-26
**Baseline:** `9f39880` (Phase 28: Synchronized Listening Rooms)
**Status:** Complete, verified, documented, cleaned up, committed (`<hash>`).
Stopped at the phase boundary — **Phase 30 was not started.**

## What was built

**Backend** (`services/api/src/modules/community/`):

- Schema: `artist_posts` (author `userId`, `artistId`, body ≤ 2000,
  optional `trackId`/`albumId`, `CommunityContentStatus`
  ACTIVE|DELETED|REMOVED), `post_comments` (flat, author soft-delete),
  `post_reactions` (composite PK `(postId, userId)`, LIKE only).
  Migration `20260926010009_phase29_community` is Phase-29-only (1 enum,
  2 new values on the moderation target enum, 3 tables, 3 indexes, 8 FKs).
  Proven by deploying all migrations from scratch into a fresh database —
  tables, enum, and constraints verified, scratch DB dropped.
- Routes: ARTIST-only post create (ownership = artists the user manages;
  authorship/status server-derived, client-supplied values ignored),
  public artist posts, authenticated chronological followed-artist feed,
  post get/edit/author-soft-delete, flat paginated comments with
  author-soft-delete, idempotent like/unlike, user-facing reporting via
  the Phase 17 workflow (`ARTIST_POST`/`POST_COMMENT` added to the
  moderation target enum in `moderation/schemas.ts` + `service.ts`).
- Attachment integrity: attached tracks must be READY and belong to the
  posting artist; attached albums must belong to the posting artist.
  Cross-artist references rejected. Attachments are DTO references —
  never audio URLs.
- Admin: `GET /v1/admin/community/posts/:id` and
  `GET /v1/admin/community/comments/:id` (any status, for review),
  `POST …/moderate` (ACTIVE|DELETED → REMOVED) and `POST …/restore`
  (REMOVED|DELETED → ACTIVE). Every action is transactional with an
  immutable Phase 16 audit row (`community.post.removed/restored`,
  `community.comment.removed/restored`). Ordinary users can never
  restore moderated content.
- Guards: per-user write limits and a duplicate-post window enforced in
  the service layer; community rate limiter in `config.ts`. ACTIVE-only
  ordinary surfaces — removed/deleted content hidden from feeds,
  profiles, search, and recommendations.
- Invariants preserved: community content is excluded from catalog
  search and AI recommendation inputs by construction (separate tables,
  no shared queries). Public DTOs carry only `id`/`displayName`/
  `avatarUrl` — no emails, roles, playlists, history, subscriptions,
  royalties, or moderation notes. PlaybackEngine, entitlements, Phase 7
  sessions, offline behavior, royalties, and rooms untouched.

**Mobile** (`apps/mobile/`):

- `src/api/community.ts`: typed wrappers for all community endpoints
  (+ `src/api/__tests__/community.test.ts`, 12 tests).
- `src/community/`: `PostCard`, `CommentRow`, `ReportDialog`,
  `useReactionToggle` (optimistic like with rollback) + 14
  component/hook tests.
- Screens: `CommunityFeedScreen` (new authenticated Community tab,
  chronological followed-artist feed, refresh, pagination,
  empty/error/loading states), `PostDetailScreen` (body, attachment chip,
  flat comments with create/delete, like/unlike, follow, report, author
  edit/delete, moderated/deleted states), `ArtistPostsScreen`,
  `ComposePostScreen` (ARTIST-only: own-artist selector, body, optional
  track/album picker with non-READY tracks disabled).
- Routes: `(tabs)/community`, `(catalog)/post/[id]`,
  `(catalog)/artist-posts/[artistId]`, `(catalog)/compose-post`.
- Artist profile shows up to 3 recent posts + "See all"; artist
  dashboard has "New post". Attached tracks play through the shared
  `PlaybackEngine` as ordinary queue items — no new player, no special
  tokens, no entitlement change.
- Reporting uses the existing Phase 17 workflow; the dialog never
  exposes moderation state.

**Admin** (`apps/admin/`):

- `ModerationTargetType` extended with `ARTIST_POST` | `POST_COMMENT`;
  new `CommunityPost`/`CommunityComment` types and six API helpers
  (review/moderate/restore for posts and comments).
- `ModerationPage`: queue filter and file-report form offer the new
  target types; report detail shows a "Reported post/comment" card
  (safe author display name, body, artist, attachment title, current
  status) with Remove/Restore behind the existing confirm dialog.
  Audit-history descriptions cover the four new community actions.
  No parallel moderation system.

## Acceptance criteria

- [x] ARTIST creates/edits/soft-deletes posts for managed artists;
      LISTENER post creation → 403; authorship server-derived.
- [x] Track/album attachments validated (READY, same-artist); invalid
      references rejected.
- [x] Chronological followed-artist feed; public artist posts; flat
      comments; idempotent likes; duplicate-post window + per-user
      write limits enforced server-side.
- [x] Reporting reuses Phase 17; admin review/remove/restore with
      immutable audit rows; ordinary users can never restore.
- [x] Removed content hidden from ordinary surfaces; DTOs carry no
      private data; community excluded from search/AI.
- [x] Attached tracks play via the shared engine with unchanged
      entitlement; no new player or playback tokens.
- [x] No commerce, tickets, chat/DMs, nested comments, ranking,
      notifications infrastructure, or new auth.
- [x] Phase 30 was not started.

## Tests

- Backend Phase 29 suite: **59/59** (`services/api/tests/phase29.test.ts`):
  ownership/roles, attachment validation, duplicates, feed
  ordering/pagination, follows, comments, reactions, reporting,
  moderation/audit, rate limits/spoof resistance, DTO privacy,
  catalog/recommendation isolation, unchanged playback entitlement.
- Backend full suite: **577/578** — the one failure is the known
  pre-existing analytics UTC-day test (`analytics.test.ts > trend >
buckets plays by UTC day`), left untouched per protocol.
- Backend TypeScript (`tsc --noEmit`): clean. Backend build: clean.
  Backend ESLint on Phase 29 sources: clean.
- Mobile full suite: **734/734**, including 26 community unit tests
  (API client, PostCard, CommentRow, useReactionToggle).
- Mobile live community suite: **7/7** against the real API
  (`community.live.test.ts`): post create + LISTENER 403, follow → feed,
  public artist posts, comment round-trip + author-only delete,
  idempotent reactions, author edit + 403, author delete → feed 404.
- Mobile TypeScript: clean. Mobile ESLint (scoped): clean. Prettier:
  applied to all Phase 29 files.
- Admin suite: **41/41** (5 new community review tests). Admin
  TypeScript: clean. Admin ESLint: clean. Admin build: clean.
- Expo Doctor: **19/21** — the 2 failures (direct `expo-modules-core`
  dependency warning; 5 outdated Expo packages) are pre-existing and
  identical to the Phase 28 baseline.
- Android export: clean. iOS export: clean.
- Secret scan across Phase 29 files: no matches.
- Migration: proven from scratch (fresh DB → `prisma migrate deploy` →
  tables/enum verified → scratch DB dropped).

## Manual checklist

- [ ] Real device: community feed scrolling, post detail, comment
      create/delete, optimistic like toggle, composer with track/album
      picker, report dialog, attached-track playback, background
      transitions, offline behavior.
- [ ] CarPlay head unit / Android Auto head unit: confirm no community
      surfaces appear and playback behaves normally.
- [ ] Accessibility pass with screen reader on device.
- [ ] No production-readiness claim until the above are evidenced.

## Honest limitations

- No push/email notification infrastructure exists; the chronological
  followed-artist feed is the bounded fan-update mechanism. A future
  notification system can subscribe to post creation without changing
  these semantics.
- Attachment picker requests up to 100 items with no pagination UI;
  large artist catalogs need picker pagination later.
- Community analytics are not part of this phase (artist analytics stay
  Phase 15 playback-based; royalties stay Phase 21).
- Single-instance assumptions from earlier phases (e.g. Phase 25 queue)
  are unchanged; no new distributed state was added.

## Files created

- `services/api/src/modules/community/` (schemas, rateLimit, service, routes)
- `services/api/tests/phase29.test.ts`
- `services/api/prisma/migrations/20260926010009_phase29_community/migration.sql`
- `apps/mobile/src/api/community.ts`
- `apps/mobile/src/api/__tests__/community.test.ts`
- `apps/mobile/src/api/__tests__/live/community.live.test.ts`
- `apps/mobile/src/community/` (components, hooks, index + tests)
- `apps/mobile/src/screens/CommunityFeedScreen.tsx`
- `apps/mobile/src/screens/PostDetailScreen.tsx`
- `apps/mobile/src/screens/ArtistPostsScreen.tsx`
- `apps/mobile/src/screens/ComposePostScreen.tsx`
- `apps/mobile/src/app/(tabs)/community.tsx`
- `apps/mobile/src/app/(catalog)/post/[id].tsx`
- `apps/mobile/src/app/(catalog)/artist-posts/[artistId].tsx`
- `apps/mobile/src/app/(catalog)/compose-post.tsx`
- `docs/adr/023-artist-fan-community.md`
- `docs/ARTIST-FAN-COMMUNITY.md`
- `docs/PHASE-29-REPORT.md`

## Files modified

- `services/api/prisma/schema.prisma`, `services/api/src/config.ts`,
  `services/api/src/http/app.ts`,
  `services/api/src/modules/moderation/schemas.ts`,
  `services/api/src/modules/moderation/service.ts`
- `apps/mobile/src/api/index.ts`
- `apps/mobile/src/app/(tabs)/_layout.tsx`,
  `apps/mobile/src/app/(catalog)/_layout.tsx`
- `apps/mobile/src/screens/index.ts`,
  `apps/mobile/src/screens/ArtistDetailScreen.tsx`,
  `apps/mobile/src/screens/ArtistDashboardScreen.tsx`
- `apps/admin/src/api/types.ts`, `apps/admin/src/api/moderation.ts`
- `apps/admin/src/pages/ModerationPage.tsx`
- `apps/admin/src/__tests__/ModerationPage.test.tsx`
- `.gitignore` (runtime-owned workspace dirs excluded from commits)

## Physical-test gaps

No Android SDK, physical mobile device, CarPlay head unit, or Android
Auto head unit exists in the sandbox. Real-device community flows,
background transitions, lock-screen controls, and car projections are
unverified — documented in the manual checklist above. The known
pre-existing analytics UTC-day backend failure and the 19/21 Expo Doctor
baseline were verified unchanged from Phase 28.
