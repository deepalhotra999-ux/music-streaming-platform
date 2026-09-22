# Collaborative Playlists — Phase 27

Owner-opt-in collaborative playlists with editor roles, invite tokens,
optimistic-concurrency revisions, and an append-only change history.
No real-time sync: the write path is plain REST with a revision
compare-and-swap (see ADR-021).

## Data model

- `Playlist.isCollaborative: boolean` (default `false`), `Playlist.revision: int` (default `0`).
- `CollaboratorRole`: `OWNER` | `EDITOR`. The owner is the playlist's
  existing owner; there is exactly one owner and it cannot change.
- `PlaylistMember(playlistId, userId, role, createdAt)` — composite PK.
- `PlaylistInvitation(id, playlistId, tokenHash, expiresAt, usedAt, revokedAt, createdAt)`
  — `tokenHash` is the SHA-256 hex of the raw token, unique. Raw token
  exists only in the 201 create response.
- `PlaylistChangeAction`: `TRACK_ADDED`, `TRACK_REMOVED`, `TRACK_MOVED`,
  `COLLAB_ENABLED`, `COLLAB_DISABLED`, `MEMBER_ADDED`, `MEMBER_REMOVED`,
  `MEMBER_LEFT`, `INVITATION_CREATED`, `INVITATION_ACCEPTED`,
  `INVITATION_REVOKED`.
- `PlaylistChange(id, playlistId, actorUserId, action, trackId?, playlistItemId?, revision, createdAt)`
  — append-only; a DB trigger rejects `UPDATE`/`DELETE`.

Migration: `services/api/prisma/migrations/20260922152249_phase27_collab/`
(Phase 27-only; also backfills `is_collaborative=false`, `revision=0`).

## Permission matrix

| Action                                 | Owner           | Editor | Non-member        |
| -------------------------------------- | --------------- | ------ | ----------------- |
| Read public playlist                   | yes             | yes    | yes               |
| Read private playlist                  | yes             | yes    | 404               |
| Add/remove/reorder tracks (collab on)  | yes             | yes    | 404               |
| Add/remove/reorder tracks (collab off) | yes             | n/a    | 404/403 as before |
| Toggle collaboration                   | yes             | 404    | 404               |
| List members / changes                 | yes             | yes    | 404               |
| Create/list/revoke invitations         | yes             | 404    | 404               |
| Remove member                          | yes (not owner) | 404    | 404               |
| Leave playlist                         | no (400)        | yes    | n/a               |

Non-member access returns 404 (existence-hiding), consistent with the
Phase 4 private-playlist convention. Owner-only routes checked by an
owner-first guard, so editors probing them also see 404.

## API

Playlist DTOs carry `isCollaborative`, `revision`; detail carries
`viewerRole: 'OWNER' | 'EDITOR' | null`.

Track mutations on collaborative playlists require `expectedRevision`
in the JSON body (400 when missing). Success returns the item and the
`x-playlist-revision` header with the new revision. Stale revision →
RFC 7807 409; the write never lands.

- `POST /v1/playlists/:id/tracks` `{ trackId, position?, expectedRevision? }` → 201
- `PATCH /v1/playlists/:id/tracks/:itemId` `{ position?, expectedRevision? }` → 200
- `DELETE /v1/playlists/:id/tracks/:itemId` `{ expectedRevision? }` → 204
  (body optional — legacy bodyless DELETE still works for
  non-collaborative playlists)
- `PATCH /v1/playlists/:id/collaboration` `{ isCollaborative }` → 200
  `{ isCollaborative, revision }` (owner only; disabling removes all
  members and revokes active invitations in one transaction)
- `GET /v1/playlists/:id/members` → `{ data: [...] }`
- `DELETE /v1/playlists/:id/members/me` → 204
- `DELETE /v1/playlists/:id/members/:memberUserId` → 204 (owner only)
- `POST /v1/playlists/:id/invitations` → 201
  `{ token, invitation: { id, expiresAt } }` — token shown exactly once
- `GET /v1/playlists/:id/invitations` → metadata only, never tokens
- `DELETE /v1/playlists/:id/invitations/:invitationId` → 204
- `POST /v1/playlists/invitations/accept` `{ token }` → 200 playlist
  detail (accepting user = authenticated session; unknown → 404,
  revoked/expired → 403, reused → 409)
- `GET /v1/playlists/:id/changes` → `{ data: [...] }` (members only)
- `GET /v1/me/playlists` includes member playlists, not just owned.

## Invitation security

256-bit `base64url` tokens, SHA-256 hash-only storage, 7-day expiry,
single-use (atomic claim on accept), owner-revocable. Tokens never
appear in list/get responses or logs.

## Concurrency

Optimistic: client sends last-seen `revision`; server does
`UPDATE ... SET revision = revision + 1 WHERE id AND revision =
expected` inside the mutation transaction. Losers get 409 and refetch.
Mobile: on 409, refetch detail (new revision + items), show a
non-blocking "updated by a collaborator" notice, roll back the failed
optimistic change.

## Offline

Collaborative editing is disabled while offline (revision cannot be
negotiated without the server). Offline downloads and playback are
unchanged (Phase 25).

## Privacy boundaries

- Private collaborative playlists: member-only reads/writes; never in
  public listings, search, or discovery recommendations.
- Public collaborative playlists: publicly readable, member-only
  writable.
- Member lists and change history: members only.
- Collaboration grants no playback entitlement.

## Future real-time extension points

The write path is already serialized through the revision
compare-and-swap, so a future push layer (WebSocket/SSE) only needs to
broadcast `(playlistId, revision, changeId)` after commit; clients
already know how to refetch-on-newer-revision. No contract changes
required.

## Limitations

- No presence, cursors, or synchronized listening (out of scope).
- No in-car collaborative editing UI (CarPlay/Android Auto are
  playback surfaces).
- History grows monotonically; retention is a future ops decision.
- Invitation delivery is out of band (no email/push); the owner shares
  the token.
