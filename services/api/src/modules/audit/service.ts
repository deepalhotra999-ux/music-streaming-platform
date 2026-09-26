// Phase 16 — admin audit foundation. Append-only record of privileged admin
// actions. Rows are immutable by construction: no service method updates or
// deletes them, the HTTP surface exposes only reads, and a database trigger
// (see migration 20260921220000_phase16_audit) rejects UPDATE/DELETE in
// depth. Metadata is limited to non-sensitive facts (role changes,
// verification flips) — never credentials, tokens, or PII beyond what the
// caller already exposes.

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../db.js';
import {
  pageEnvelope,
  parsePagination,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface RecordAuditEventInput {
  /**
   * Admin who performed the action. Null when actor is unknown/system.
   * Optional when `actor` is given (the actor object takes precedence).
   */
  actorId?: string | null;
  /**
   * Admin V2 — preferred over actorId when the caller has an AuthUser:
   * derives actorId AND impersonation attribution (impersonatedBy) from the
   * acting identity in one place, so impersonated sessions are always
   * attributed to the SUPER_ADMIN behind them. Takes precedence over
   * actorId/impersonatedBy when both are given.
   */
  actor?: { id: string; impersonation?: { adminId: string; reason: string } | null };
  /** Machine-readable action name, e.g. 'user.role.changed'. */
  action: string;
  /** Entity type the action targeted, e.g. 'user', 'artist'. */
  targetType: string;
  /** UUID of the targeted row, when applicable. */
  targetId?: string | null;
  /**
   * Non-sensitive facts only: role names, verification booleans, status
   * values. Never credentials, tokens, secrets, or free-form user input.
   */
  metadata?: Record<string, unknown>;
  /**
   * Admin governance — set true when the main admin can invert this action
   * via POST /v1/admin/audit-logs/:id/reverse. Reversible actions must carry
   * beforeState/afterState with the facts needed to restore the prior state.
   */
  reversible?: boolean;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  /** Set on reversal rows: the audit row this action inverts. */
  reversalOf?: string | null;
  /**
   * Admin V2 impersonation attribution. When an action is performed under an
   * impersonation session, the acting identity (actorId) is the impersonated
   * user, and this carries the SUPER_ADMIN behind the session plus the
   * recorded reason. Written into metadata.impersonatedBy at write time.
   */
  impersonatedBy?: { adminId: string; reason: string } | null;
}

export interface AuditEventDto {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  reversible: boolean;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  reversalOf: string | null;
  /** True when a reversal row already exists for this event. */
  reversed: boolean;
  createdAt: Date;
}

function toDto(
  row: {
    id: string;
    actorId: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    metadata: unknown;
    reversible: boolean;
    beforeState: unknown;
    afterState: unknown;
    reversalOf: string | null;
    createdAt: Date;
  },
  reversedIds?: Set<string>,
): AuditEventDto {
  return {
    id: row.id,
    actorId: row.actorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    reversible: row.reversible,
    beforeState: (row.beforeState ?? null) as Record<string, unknown> | null,
    afterState: (row.afterState ?? null) as Record<string, unknown> | null,
    reversalOf: row.reversalOf,
    reversed: reversedIds ? reversedIds.has(row.id) : false,
    createdAt: row.createdAt,
  };
}

export async function recordAuditEvent(
  input: RecordAuditEventInput,
  db: Db = prisma,
): Promise<AuditEventDto> {
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
  // The `actor` object (preferred) derives both the acting identity and the
  // impersonation attribution; explicit actorId/impersonatedBy are the legacy
  // path and are ignored when `actor` is present.
  const identity = input.actor ? actorIdentity(input.actor) : null;
  const actorId = identity ? identity.actorId : input.actorId;
  const impersonatedBy = identity ? identity.impersonatedBy : input.impersonatedBy;
  if (impersonatedBy) {
    metadata.impersonatedBy = {
      adminId: impersonatedBy.adminId,
      reason: impersonatedBy.reason,
    };
  }
  const row = await db.adminAuditLog.create({
    data: {
      actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      metadata: metadata as Prisma.InputJsonValue,
      reversible: input.reversible ?? false,
      beforeState: (input.beforeState ?? null) as Prisma.InputJsonValue,
      afterState: (input.afterState ?? null) as Prisma.InputJsonValue,
      reversalOf: input.reversalOf ?? null,
    },
  });
  return toDto(row);
}

/**
 * Admin V2 — build the actor identity fields for an audit write from an
 * authenticated user, carrying impersonation attribution when present.
 */
export function actorIdentity(actor: {
  id: string;
  impersonation?: { adminId: string; reason: string } | null;
}): Pick<RecordAuditEventInput, 'actorId' | 'impersonatedBy'> {
  return {
    actorId: actor.id,
    impersonatedBy: actor.impersonation
      ? { adminId: actor.impersonation.adminId, reason: actor.impersonation.reason }
      : null,
  };
}

export interface ListAuditEventsQuery extends PaginationQuery {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
}

export async function listAuditEvents(
  query: ListAuditEventsQuery,
  db: Db = prisma,
): Promise<PageEnvelope<AuditEventDto>> {
  const p = parsePagination(query);
  const where = {
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.targetType ? { targetType: query.targetType } : {}),
    ...(query.targetId ? { targetId: query.targetId } : {}),
  };
  const [rows, total] = await Promise.all([
    db.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.limit,
    }),
    db.adminAuditLog.count({ where }),
  ]);
  // Mark events that already have a reversal row (append-only: we never
  // UPDATE the original, so "reversed" is derived from reversal rows).
  const ids = rows.map((r) => r.id);
  const reversalRows =
    ids.length > 0
      ? await db.adminAuditLog.findMany({
          where: { reversalOf: { in: ids } },
          select: { reversalOf: true },
        })
      : [];
  const reversedIds = new Set(
    reversalRows.map((r) => r.reversalOf).filter((v): v is string => v !== null),
  );
  return pageEnvelope(rows.map((r) => toDto(r, reversedIds)), total, p);
}
