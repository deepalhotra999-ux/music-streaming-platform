# Artist–Fan Community

**Phase:** 29 · **ADR:** [ADR-023](adr/023-artist-fan-community.md)

Artists publish short posts — tour news, release notes, behind-the-scenes
— optionally referencing one of their own tracks or albums. Fans follow
artists and get a chronological feed of posts from the artists they
follow. Anyone signed in can comment on a post and like it once. All of
this lives outside the music catalog: community content never appears in
search, recommendations, or analytics.

## Concepts

- **Artist post.** Up to 2000 characters, authored by an ARTIST account
  for one of their own artists. Optional attachments: one of _their own_
  READY tracks, or one of _their own_ albums. Attachments are references
  (title, artist, duration) — never audio.
- **Comment.** Flat (no threads), up to 2000 characters, on any ACTIVE
  post. Authors can soft-delete their own comments.
- **Like.** One LIKE per (post, user). Tapping again removes it —
  idempotent both ways.
- **Feed.** Chronological list of ACTIVE posts from artists you follow.
  This is also the fan update mechanism — there is no push/email
  notification system; new posts appear when you open the Community tab.
- **Statuses.** `ACTIVE` (visible), `DELETED` (author-removed, hidden from
  ordinary surfaces), `REMOVED` (moderator-removed, hidden from ordinary
  surfaces, restorable only by admins).

## Rules

- Only ARTIST accounts can post, and only for artists they manage.
  LISTENERs get 403. Authorship and status are always server-derived —
  the API ignores client-supplied author/status fields.
- Attached tracks must be READY and belong to the posting artist;
  attached albums must belong to the posting artist. Cross-artist
  references are rejected.
- Reports go through the standard Phase 17 moderation queue
  (`ARTIST_POST` / `POST_COMMENT` targets). Anyone signed in can report.
- Removed content is hidden from feeds, artist profiles, search, and
  recommendations. Ordinary users can never restore moderated content.
- Every moderation action (remove/restore) is transactional and writes
  an immutable audit row (`community.post.removed`, etc.).
- Public DTOs carry only the safe author shape: `id`, `displayName`,
  `avatarUrl`. No emails, roles, playlists, history, subscriptions,
  royalties, or moderation notes.

## API

Base path `/v1/community` (+ admin paths under `/v1/admin/community`).

| Method & path                                    | Auth     | Description                               |
| ------------------------------------------------ | -------- | ----------------------------------------- |
| `POST /v1/community/posts`                       | ARTIST   | Create a post for a managed artist        |
| `GET /v1/community/posts/:id`                    | optional | Get an ACTIVE post                        |
| `PATCH /v1/community/posts/:id`                  | author   | Edit own post body                        |
| `DELETE /v1/community/posts/:id`                 | author   | Soft-delete own post                      |
| `GET /v1/community/feed`                         | user     | Chronological posts from followed artists |
| `GET /v1/community/artists/:artistId/posts`      | public   | An artist's ACTIVE posts                  |
| `GET /v1/community/posts/:id/comments`           | optional | Flat paginated comments                   |
| `POST /v1/community/posts/:id/comments`          | user     | Comment on a post                         |
| `DELETE /v1/community/comments/:id`              | author   | Soft-delete own comment                   |
| `POST /v1/community/posts/:id/reactions`         | user     | Like (idempotent)                         |
| `DELETE /v1/community/posts/:id/reactions`       | user     | Unlike (idempotent)                       |
| `POST /v1/moderation-reports`                    | user     | Report a post or comment                  |
| `GET /v1/admin/community/posts/:id`              | ADMIN    | Review a post in any status               |
| `GET /v1/admin/community/comments/:id`           | ADMIN    | Review a comment in any status            |
| `POST /v1/admin/community/posts/:id/moderate`    | ADMIN    | Remove a post                             |
| `POST /v1/admin/community/posts/:id/restore`     | ADMIN    | Restore a post                            |
| `POST /v1/admin/community/comments/:id/moderate` | ADMIN    | Remove a comment                          |
| `POST /v1/admin/community/comments/:id/restore`  | ADMIN    | Restore a comment                         |

Envelopes follow the platform conventions (`{ data, pagination }` for
lists, RFC 7807 problems for errors). Per-user write limits and a
duplicate-post window are enforced server-side.

## Mobile

- **Community tab** (authenticated): chronological followed-artist feed,
  pull-to-refresh, pagination, empty/error/loading states.
- **Post detail**: full body, attachment chip, flat comments with
  create/delete, like/unlike with optimistic toggle + rollback, follow
  button, report dialog, author edit/delete.
- **Artist profile**: up to 3 recent posts + "See all" → full artist
  post list.
- **Composer** (ARTIST role): own-artist selector, body, optional
  track/album picker (non-READY tracks disabled).
- **Dashboard**: "New post" entry for artists.
- Tapping an attached track plays it through the shared
  `PlaybackEngine` as an ordinary queue item — no special playback
  tokens, no entitlement change.
- Reporting uses the existing Phase 17 workflow; the dialog never
  exposes moderation state.

## Admin

The existing moderation queue handles community reports: filter by
`ARTIST_POST`/`POST_COMMENT`, open a report to see a "Reported
post/comment" card (author display name, body, attachment title, current
status), and **Remove** / **Restore** with confirmation. Every action
lands in the immutable audit log and the report's history view.

## What community is NOT

- Not in catalog search, not in AI recommendations, not in analytics or
  royalty calculations.
- No nested comments, no reaction variety, no ranking/personalization.
- No chat, DMs, or live streaming.
- No commerce, tickets, or merchandise.
