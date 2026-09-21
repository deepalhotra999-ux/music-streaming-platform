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

type Db = PrismaClient;

export interface RecordAuditEventInput {
  /** Admin who performed the action. Null when actor is unknown/system. */
  actorId: string | null;
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
}

export interface AuditEventDto {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

function toDto(row: {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: unknown;
  createdAt: Date;
}): AuditEventDto {
  return {
    id: row.id,
    actorId: row.actorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

export async function recordAuditEvent(
  input: RecordAuditEventInput,
  db: Db = prisma,
): Promise<AuditEventDto> {
  const row = await db.adminAuditLog.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
  return toDto(row);
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
  return pageEnvelope(rows.map(toDto), total, p);
}
