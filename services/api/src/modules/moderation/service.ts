// Phase 17 — moderation foundation. Service layer for moderation reports.
//
// Reports are the smallest maintainable moderation model the Phase 17 brief
// requires: a row carries the moderation status, reason, timestamps, and the
// acting administrator. History is not stored here — every successful
// mutation also writes an append-only row to admin_audit_logs (Phase 16),
// which is the auditable moderation history.
//
// Status machine: OPEN -> UNDER_REVIEW | RESOLVED | DISMISSED;
// UNDER_REVIEW -> RESOLVED | DISMISSED | OPEN (back to queue).
// RESOLVED and DISMISSED are terminal: a wrongly closed report is superseded
// by filing a new report, never by rewriting history.

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../db.js';
import { badRequest, notFound, unprocessableEntity } from '../../http/errors.js';
import type { AuthUser } from '../../http/auth.js';
import { recordAuditEvent } from '../audit/service.js';
import {
  pageEnvelope,
  parsePagination,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';

type Db = PrismaClient;

export type ModerationTargetType = 'ARTIST' | 'ALBUM' | 'TRACK';
export type ModerationStatus = 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED' | 'DISMISSED';

export interface ModerationReportDto {
  id: string;
  targetType: ModerationTargetType;
  targetId: string;
  reason: string;
  details: string | null;
  status: ModerationStatus;
  createdById: string | null;
  reviewedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateModerationReportInput {
  targetType: ModerationTargetType;
  targetId: string;
  reason: string;
  details?: string;
}

export interface UpdateModerationReportInput {
  status?: ModerationStatus;
  reason?: string;
  details?: string | null;
}

export interface ListModerationReportsQuery extends PaginationQuery {
  status?: ModerationStatus;
  targetType?: ModerationTargetType;
  targetId?: string;
}

const VALID_TRANSITIONS: Record<ModerationStatus, readonly ModerationStatus[]> = {
  OPEN: ['UNDER_REVIEW', 'RESOLVED', 'DISMISSED'],
  UNDER_REVIEW: ['OPEN', 'RESOLVED', 'DISMISSED'],
  RESOLVED: [],
  DISMISSED: [],
};

function toDto(row: {
  id: string;
  targetType: ModerationTargetType;
  targetId: string;
  reason: string;
  details: string | null;
  status: ModerationStatus;
  createdById: string | null;
  reviewedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ModerationReportDto {
  return { ...row };
}

async function assertTargetExists(
  targetType: ModerationTargetType,
  targetId: string,
  db: Db,
): Promise<void> {
  // Soft-deleted rows remain reportable (they may be under review), but the
  // target must exist at all — this also blocks typos and cross-type IDs.
  const found =
    targetType === 'ARTIST'
      ? await db.artist.findUnique({ where: { id: targetId }, select: { id: true } })
      : targetType === 'ALBUM'
        ? await db.album.findUnique({ where: { id: targetId }, select: { id: true } })
        : await db.track.findUnique({ where: { id: targetId }, select: { id: true } });
  if (!found) {
    throw notFound(`${targetType.charAt(0) + targetType.slice(1).toLowerCase()} not found.`);
  }
}

export async function createModerationReport(
  input: CreateModerationReportInput,
  actor: AuthUser,
  db: Db = prisma,
): Promise<ModerationReportDto> {
  await assertTargetExists(input.targetType, input.targetId, db);
  // Atomic: the report row and its audit row commit together. If the audit
  // write fails, the report is rolled back — no unaudited admin action.
  const row = await db.$transaction(async (tx) => {
    const created = await tx.moderationReport.create({
      data: {
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason.trim(),
        details: input.details?.trim() ? input.details.trim() : null,
        createdById: actor.id,
      },
    });
    await recordAuditEvent(
      {
        actorId: actor.id,
        action: 'moderation.report.created',
        targetType: 'moderation_report',
        targetId: created.id,
        metadata: {
          reportTargetType: created.targetType,
          reportTargetId: created.targetId,
          // Note: the free-form reason lives only in moderation_reports, never
          // in audit metadata (facts-only metadata policy).
        },
      },
      tx,
    );
    return created;
  });
  return toDto(row);
}

export async function listModerationReports(
  query: ListModerationReportsQuery,
  db: Db = prisma,
): Promise<PageEnvelope<ModerationReportDto>> {
  const p = parsePagination(query);
  const where: Prisma.ModerationReportWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.targetType ? { targetType: query.targetType } : {}),
    ...(query.targetId ? { targetId: query.targetId } : {}),
  };
  const [rows, total] = await Promise.all([
    db.moderationReport.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.limit,
    }),
    db.moderationReport.count({ where }),
  ]);
  return pageEnvelope(rows.map(toDto), total, p);
}

export async function getModerationReport(
  id: string,
  db: Db = prisma,
): Promise<ModerationReportDto> {
  const row = await db.moderationReport.findUnique({ where: { id } });
  if (!row) {
    throw notFound('Moderation report not found.');
  }
  return toDto(row);
}

export async function updateModerationReport(
  id: string,
  input: UpdateModerationReportInput,
  actor: AuthUser,
  db: Db = prisma,
): Promise<ModerationReportDto> {
  const existing = await db.moderationReport.findUnique({ where: { id } });
  if (!existing) {
    throw notFound('Moderation report not found.');
  }

  if (input.status !== undefined && input.status !== existing.status) {
    if (!VALID_TRANSITIONS[existing.status].includes(input.status)) {
      throw unprocessableEntity(
        `Cannot move a report from ${existing.status} to ${input.status}. ` +
          'RESOLVED and DISMISSED reports are terminal; file a new report instead.',
      );
    }
  }

  const data: Prisma.ModerationReportUpdateInput = {
    ...(input.reason !== undefined ? { reason: input.reason.trim() } : {}),
    ...(input.details !== undefined
      ? { details: input.details === null || !input.details.trim() ? null : input.details.trim() }
      : {}),
    ...(input.status !== undefined && input.status !== existing.status
      ? { status: input.status, reviewedById: actor.id }
      : {}),
  };

  // Atomic: the report update and its audit rows commit together. Failed or
  // denied attempts throw before this point, so no audit row is written
  // for them.
  const row = await db.$transaction(async (tx) => {
    const updated = await tx.moderationReport.update({ where: { id }, data });

    if (input.status !== undefined && input.status !== existing.status) {
      await recordAuditEvent(
        {
          actorId: actor.id,
          action: 'moderation.report.status_changed',
          targetType: 'moderation_report',
          targetId: updated.id,
          metadata: { oldStatus: existing.status, newStatus: updated.status },
        },
        tx,
      );
    }
    const editedFields = [
      ...(input.reason !== undefined ? ['reason'] : []),
      ...(input.details !== undefined ? ['details'] : []),
    ];
    if (editedFields.length > 0) {
      await recordAuditEvent(
        {
          actorId: actor.id,
          action: 'moderation.report.updated',
          targetType: 'moderation_report',
          targetId: updated.id,
          metadata: { fields: editedFields },
        },
        tx,
      );
    }
    return updated;
  });
  return toDto(row);
}

// Phase 17 — guard against empty-string reasons that pass JSON Schema
// minLength after trimming.
export function validateReportInput(input: { reason?: string }): void {
  if (input.reason !== undefined && input.reason.trim().length < 3) {
    throw badRequest('Reason must be at least 3 characters.');
  }
}
