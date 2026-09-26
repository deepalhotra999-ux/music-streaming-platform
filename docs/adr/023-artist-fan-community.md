# ADR-023: Artist/Fan Community — Posts, Comments, Likes Under Existing Moderation & Catalog Isolation

**Date:** 2026-09-26
**Status:** Accepted
**Phase:** 29

## Context

Phase 29 adds the first social surface to the platform: verified artists
can publish short posts (optionally referencing one of their own tracks or
albums), fans can follow artists and see a chronological feed of posts from
artists they follow, and anyone can comment on posts and like them once.
The core tensions:

1. **Community is not the catalog.** Posts, comments, and likes are
   user-generated social content. They must never leak into catalog search,
   AI recommendations, or any discovery surface — those are catalog-only
   (ADR-020's AI boundary stands).
2. **Reuse moderation, don't fork it.** Phase 17 built a report queue,
   status workflow, and immutable audit log for catalog content. Community
   reports must flow through the same queue, the same review UI, and the
   same audit trail — no parallel moderation system.
3. **Privacy by DTO.** Community DTOs cross trust boundaries (public
   feeds, admin review). They must carry the safe public author shape
   (`id`, `displayName`, `avatarUrl`) and nothing else — no emails, roles,
   playlists, history, subscriptions, royalties, or moderation notes.
4. **No new playback semantics.** Attached tracks are references, not
   licenses. Playing an attached track goes through the existing
   Phase 7 playback session + entitlement path and the single shared
   `PlaybackEngine` (Phases 8–10). No special community playback tokens.
5. **No new notification infrastructure.** There is no general
   push/email notification architecture in the platform. The bounded
   follower-update mechanism is the chronological followed-artist feed
   itself — fans see new posts when they open the Community tab.

## Decision summary

1. **Schema: three tables, one enum.** `artist_posts` (author `userId`,
   `artistId`, body ≤ 2000 chars, optional `trackId`/`albumId`,
   `CommunityContentStatus` ACTIVE|DELETED|REMOVED), `post_comments`
   (flat, author-soft-delete), `post_reactions` (composite PK
   `(postId, userId)`, LIKE only). Migration
   `20260926010009_phase29_community` is Phase-29-only (1 enum, 2 new
   target values on the moderation enum, 3 tables, 3 indexes, 8 FKs).
2. **Authorship is server-derived.** Post authorship = the authenticated
   user; artist identity = an artist the user can manage (owner or ADMIN).
   The API ignores any client-supplied `authorUserId`/`status`. LISTENERs
   get 403 on post creation; anyone authenticated can comment/react/report.
3. **Attachment integrity.** Attached tracks must be READY (Phase 14
   processing state) and belong to the same artist; albums must belong to
   the same artist. Cross-artist references get 400/403. The attachment is
   a reference — the DTO carries title/artist/duration, never audio URLs.
4. **Feed = follows, chronological.** `GET /v1/community/feed` returns
   ACTIVE posts from followed artists, newest first, paginated. Public
   artist posts (`GET /v1/community/artists/:artistId/posts`) are visible
   without auth. No ranking, no personalization, no AI input.
5. **Soft-delete + moderation states.** Authors soft-delete their own
   posts/comments (DELETED — hidden from ordinary surfaces, visible to
   admins). ADMINs move ACTIVE|DELETED → REMOVED via dedicated endpoints;
   only ADMINs restore (REMOVED|DELETED → ACTIVE). Ordinary users can
   never restore moderated content. Every moderation action is
   transactional with an immutable Phase 16 audit row
   (`community.post.removed/restored`, `community.comment.removed/restored`).
6. **Reporting reuses Phase 17.** `ARTIST_POST` and `POST_COMMENT` join
   the existing moderation target enum. Users file reports through the
   user-facing reports endpoint; admins review them in the same queue,
   see the reported content in any status via new admin GET endpoints,
   and remove/restore from the report detail view. No new moderation
   workflow, no new audit mechanism.
7. **Abuse guards are server-side.** Per-user write limits and a
   duplicate-post window are enforced in the service layer, not the UI.
   Rate limits reuse the existing community route limiter.
8. **Mobile: bounded social UI.** A Community tab (authenticated), post
   detail with flat comments, artist profile recent-posts section,
   ARTIST-only composer, and report dialog — all on the existing
   `ApiClient`, existing `PlaybackEngine` (attached tracks play as
   ordinary queue items), and existing navigation. Optimistic like
   toggles with rollback. No nested comments, no broad reaction system,
   no chat, no DMs.
9. **Admin UI extends the queue.** The ModerationPage report detail
   shows a "Reported post/comment" card (safe author, body, status,
   attachment title) with Remove/Restore actions behind the existing
   confirm dialog; the filter and file-report forms gain the two new
   target types. Audit history descriptions cover the new actions.

## Consequences

- Community content is invisible to catalog search, AI recommendations,
  and analytics/royalty pipelines — by construction (separate tables,
  separate services, no shared queries).
- Removed content vanishes from feeds/profiles/search for ordinary
  users; admins can always review and restore it. Audit log stays the
  single source of moderation truth.
- The followed-artist feed is the only fan update mechanism; a future
  notification system can subscribe to post creation without changing
  these semantics.
- Per-user write limits and duplicate windows are deliberately
  conservative; they can be tuned via `config.ts` without schema change.

## Alternatives considered

- **Separate moderation service for community:** rejected — duplicates
  the report lifecycle, splits the audit trail, and doubles the admin UI.
- **Nested/threaded comments:** rejected as out of scope — flat,
  paginated comments satisfy the phase with far less moderation surface.
- **Reaction variety (emojis, counts):** rejected — one idempotent LIKE
  keeps semantics trivial and abuse-resistant.
- **Ranking/personalized feed:** rejected — chronological followed-artist
  feed is predictable, private (derived from the user's own follows),
  and needs no new data pipeline.
