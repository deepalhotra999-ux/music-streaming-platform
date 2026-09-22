# ADR-021: Collaborative Playlist Concurrency, Membership & Invitation Security

**Date:** 2026-09-22
**Status:** Accepted
**Phase:** 27

## Context

Phase 27 adds collaborative playlists: an owner can opt a playlist into
collaboration, invite other users as editors, and let them add, remove, and
reorder tracks. The core tensions:

1. **Concurrent edits** — two editors adding tracks at the same time must
   not silently clobber each other. There is no real-time sync layer
   (explicitly out of scope), so the protocol must be safe over plain
   REST request/response.
2. **Privacy** — private collaborative playlists and their member lists
   must not leak through search, recommendations, or public endpoints.
   The old "non-owner gets 404" convention from Phase 4 must extend to
   membership-gated resources.
3. **Invitation security** — invite tokens must be single-use, expiring,
   revocable, and never stored or re-served in plaintext.
4. **Append-only history** — the change log must be tamper-evident even
   to database operators, so royalty and moderation audits can trust it.

## Decision summary

1. **Optimistic concurrency with a monotonic playlist revision.**
   Every collaborative track mutation requires the caller's last-seen
   `revision` (`expectedRevision`). The revision bump and the mutation
   happen atomically (single `updateMany` with a `revision = expected`
   predicate inside the transaction); a stale revision yields RFC 7807
   `409` and the write never lands. The new revision is returned in the
   `x-playlist-revision` response header — not in the item body, so the
   item schema stays unchanged.
2. **Membership is server-derived, never client-supplied.** Roles are
   `OWNER` | `EDITOR` only. The owner is the playlist's existing owner;
   the owner cannot be removed and cannot leave. Every identity in
   mutations, history, and accept flows comes from the authenticated
   session. Unknown JSON properties are stripped by validation
   (`additionalProperties: false` + AJV `removeAdditional`), so spoof
   fields never reach handlers.
3. **Invitation tokens are hash-only.** The raw token is
   `randomBytes(32).toString('base64url')`, returned exactly once in
   the 201 create response. Only the SHA-256 hex digest is stored.
   Invitations are single-use, expire after 7 days, and are revocable;
   used/expired/revoked tokens are rejected (404/403/409 respectively).
   Disable-collaboration deletes all members and revokes all active
   invitations in the same transaction.
4. **Change history is append-only at the database level.** A trigger
   (`playlist_changes_no_mutation`) rejects `UPDATE` and `DELETE` on
   `playlist_changes`, mirroring the Phase 16 audit-log pattern. History
   rows are written in the same transaction as the mutation that caused
   them, so rollback is all-or-nothing.
5. **Existence-hiding 404s for non-members.** Any non-member access to
   a membership-gated resource (members, invitations, changes,
   collaboration settings, writes) returns 404, not 403 — the same
   convention Phase 4 uses for private playlists. Owner-only mutations
   attempted by editors also return 404 (owner check runs first).
6. **No offline collaborative editing.** Collaborative mutations are
   disabled when the client is offline; the revision protocol cannot be
   enforced without a server round-trip. Offline downloads and playback
   (Phase 25) are unaffected.

## 1. Revision protocol

```
Client reads playlist detail            → { revision: 41, ... }
Client mutates with expectedRevision:41 → POST /v1/playlists/:id/tracks
                                          { trackId, expectedRevision: 41 }
Server (in transaction):
  1. load playlist, verify member role ∈ {OWNER, EDITOR}
  2. UPDATE playlists SET revision = revision + 1
     WHERE id = :id AND revision = 41        -- atomic compare-and-swap
  3. if rowCount = 0 → rollback → 409 RFC 7807 (stale)
  4. apply mutation, INSERT playlist_changes row
  5. commit
Response: 201 + header x-playlist-revision: 42
```

Why a header: the track-item schema is shared with non-collaborative
flows and the mobile item type. Threading a new field through every
item body would widen the contract; a header carries the revision
without touching item shapes.

Why not row locking: the compare-and-swap `updateMany` avoids holding
locks across the whole transaction while still guaranteeing that only
one writer wins per revision. Losers get 409 and refetch.

## 2. Invitation security

- Entropy: 256 bits, base64url — not guessable, not sequential.
- Storage: SHA-256 hex digest only (`tokenHash`, unique). The raw
  token exists only in the create response and the user's clipboard.
- Lifecycle: `expiresAt = now + 7d`; `usedAt` set on first successful
  accept (single-use — the accept transaction claims the invitation
  with an atomic predicate, so double-accept races resolve to one
  winner); `revokedAt` set by owner revoke.
- Listing (`GET .../invitations`) returns metadata only — ids,
  timestamps — never tokens.

## 3. Privacy boundaries

- Private collaborative playlists: visible only to owner + members.
  Non-members get 404 on detail, members, invitations, changes, and
  writes; the playlist never appears in public listings, search, or
  discovery recommendations.
- Public collaborative playlists: readable by anyone (incl.
  anonymous), writable only by members.
- Member lists and change history never leak outside membership.
- Collaboration grants no playback entitlement — entitlement checks
  are unchanged.

## 4. Transaction scope

Mutation, revision bump, and history insert are one Prisma
transaction. A failing mutation (duplicate track, takedown track,
stale revision) leaves revision unchanged and writes no partial
rows — verified by rollback tests.

## Alternatives considered

- **CRDT / OT merge semantics**: rejected — overkill for playlist
  edits, and the explicit "no WebSockets, no real-time" boundary
  makes server-mediated serialization sufficient.
- **Row-level locking (`SELECT ... FOR UPDATE`)**: rejected in
  favor of compare-and-swap; avoids lock contention under bursty
  collaborative edits.
- **Storing raw invite tokens**: rejected — a DB read leak would
  hand out live invitations.
- **Real-time sync (WebSockets)**: explicitly out of scope per the
  phase brief; the revision protocol is designed to be compatible
  with a future push-based extension (see "Future" in
  COLLABORATIVE-PLAYLISTS.md) without changing the write path.

## Consequences

- Clients must track revision per playlist and refetch on 409.
- No collaborative editing while offline (revision cannot be
  negotiated without the server).
- History table grows monotonically — retention policy is a future
  operations decision, not a Phase 27 concern.
