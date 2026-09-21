# 013. Admin operations: moderation reports, catalog actions, user management

Date: 2026-09-21
Status: accepted

## Context

Phase 17 extends the Phase 16 admin panel with real operations work:
user management (account status, detail, owned artists), artist
oversight (verification history, analytics summary), catalog
actions (takedown/restore, delete), and the smallest maintainable
moderation model. Hard constraints from the brief:

- ADMIN authorization stays server-authoritative; LISTENER/ARTIST get
  403 from every new admin endpoint. Frontend hiding is not auth.
- Reuse the immutable Phase 16 `admin_audit_logs`; no second audit
  system. Every successful admin mutation is audited; denied/failed
  mutations write nothing.
- No bulk destructive actions. Confirmed, single-target operations only.
- Never expose passwords, tokens, secrets, private storage keys, or
  raw S3/audio URLs. No permanent deletion of financial/audit records.
- Enable/disable or suspension only if the model supports it cleanly.
- Do not invent legal/copyright determinations or build a complete
  takedown system.
- Hard exclusions: subscriptions, payments, royalty calculations,
  payouts, DRM, CarPlay/Android Auto, AI recommendations, social
  listening, commerce, complete copyright/takedown workflows,
  production AWS deployment.

## Decision

1. **Moderation = workflow over reports, not a status column on
   content.** A new `moderation_reports` table holds polymorphic
   reports (target type ARTIST/ALBUM/TRACK + target id, free-form
   reason + optional details, status OPEN/UNDER_REVIEW/RESOLVED/
   DISMISSED, createdBy/reviewedBy admin references, timestamps).
   We deliberately did *not* add a canonical moderation-status field
   to artists/albums/tracks: the brief asked for the smallest
   maintainable model, and a per-content status column would have
   duplicated the report workflow and invited a second audit-history
   system. Content state is interpreted from reports: any OPEN or
   UNDER_REVIEW report means the target is under active review;
   RESOLVED/DISMISSED reports are terminal history. Admins act on
   content through the existing catalog actions (takedown, delete),
   which are themselves audited.

2. **Audit metadata is facts-only; free-form text stays in the
   domain tables.** The moderation `reason` is stored only in
   `moderation_reports`. Audit rows carry structured facts
   (reportTargetType, reportTargetId, oldStatus/newStatus, fields
   changed) and never free-form user text. This keeps the audit log
   a reliable, queryable record rather than a copy of user input.

3. **Admin mutations are transactional with their audit rows.**
   `createModerationReport` and `updateModerationReport` run the
   domain write and the audit write inside one Prisma transaction:
   if the audit write fails, the mutation rolls back, so there is
   no unaudited admin action and no audit row for a failed action.
   To support this, the audit module's `recordAuditEvent` accepts
   `PrismaClient | Prisma.TransactionClient`.

4. **No suspension/enable/disable mutation.** The user model has
   soft-delete (`deletedAt`) but no suspended/disabled state, and
   bolting one on would have touched auth semantics (login, token
   refresh, playback entitlement) across the whole platform. The
   brief explicitly allowed skipping this when the model did not
   support it cleanly. Admins see account status (active vs
   soft-deleted) via `deletedAt` on the admin list/detail DTOs and
   can include deleted accounts in the user list.

5. **Auth responses are untouched.** The admin `deletedAt` field is
   an optional addition to the shared user schema used by the
   ADMIN-only user list/detail endpoints; the auth module's own
   `toPublicUser` (register/login/me) does not serialize it, so
   public auth API compatibility is unchanged.

6. **Takedown is enforced by the streaming layer, not the list
   endpoint.** Setting a track to TAKEDOWN blocks playback session
   creation (the streaming module requires READY status); the
   public catalog list still returns track metadata (pre-existing
   behavior for all non-READY statuses). Changing public list
   filtering would have been a product-level behavior change
   outside this phase's scope; the audio itself is protected.

7. **Migration ordering is chronological.** The Phase 17 migration
   was renamed to `20260921230000_phase17_moderation` so migration
   filenames sort after Phase 15 (`20260921210000`) and Phase 16
   (`20260921220000`); the `_prisma_migrations` records in both
   databases were updated to match.

## Consequences

- Moderation history is queryable per target and per admin; the
  admin SPA shows report lifecycle, valid transitions, and the
  audit trail for each report.
- Every admin mutation (role change, verify/unverify, takedown/
  restore, delete, moderation create/update) is atomic with its
  audit row; failed or denied attempts leave no trace in the log.
- The audit log remains the single, immutable, append-only record;
  the DB trigger still rejects UPDATE/DELETE on it.
- Future phases can add a suspension state or public-list
  filtering as explicit product decisions with their own
  migrations and tests.
