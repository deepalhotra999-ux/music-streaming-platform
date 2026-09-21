// Phase 18 — subscriptions. Subscription lifecycle service.
//
// Responsibilities:
// - Apply provider events to subscription state through a validated state
//   machine. Invalid transitions are rejected (422); valid ones update the
//   subscription row and append exactly one SubscriptionEvent row, in a
//   single transaction.
// - Idempotency: (provider, providerEventId) is unique. A duplicate
//   delivery returns the current state without writing new history.
// - Never trust client claims: events enter only through provider adapters
//   (DEV adapter for deterministic testing; APPLE/GOOGLE are future
//   boundaries that throw today).
// - Financial history is append-only: status on Subscription is a cached
//   projection; SubscriptionEvent rows are the reconstructable record.

import type {
  Prisma,
  PrismaClient,
  SubscriptionEventType,
  SubscriptionProvider,
  SubscriptionStatus,
} from '@prisma/client';
import { conflict, notFound, unprocessableEntity } from '../../http/errors.js';
import type { NormalizedProviderEvent } from './providers.js';

/**
 * Phase 18 — facts sanitization. Provider event facts are free-form metadata,
 * but card/payment data must never reach storage. Keys matching payment-like
 * patterns are rejected outright.
 */
const FORBIDDEN_FACT_KEYS =
  /card|payment|iban|account|routing|ssn|cvv|cvc|pin|secret|token|password/i;

export function sanitizeFacts(facts: Record<string, string> | undefined): Record<string, string> {
  if (!facts) return {};
  for (const key of Object.keys(facts)) {
    if (FORBIDDEN_FACT_KEYS.test(key)) {
      throw unprocessableEntity(
        `Fact key "${key}" looks like payment or secret data and is not allowed.`,
      );
    }
  }
  return facts;
}

/** Valid status transitions. Terminal states (EXPIRED, REVOKED) have no exits. */
export const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  ACTIVE: ['PAST_DUE', 'CANCELED', 'EXPIRED', 'REVOKED'],
  TRIALING: ['ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED', 'REVOKED'],
  PAST_DUE: ['ACTIVE', 'CANCELED', 'EXPIRED', 'REVOKED'],
  CANCELED: ['EXPIRED', 'REVOKED'],
  EXPIRED: [],
  REVOKED: [],
};

/** Which event types may create a subscription when none exists. */
const CREATING_EVENTS: SubscriptionEventType[] = ['SUBSCRIPTION_STARTED', 'TRIAL_STARTED'];

/** Target status per event type; null means "no status change". */
function targetStatusFor(eventType: SubscriptionEventType): SubscriptionStatus | null {
  switch (eventType) {
    case 'SUBSCRIPTION_STARTED':
      return 'ACTIVE';
    case 'TRIAL_STARTED':
      return 'TRIALING';
    case 'TRIAL_CONVERTED':
      return 'ACTIVE';
    case 'RENEWAL_SUCCEEDED':
      return 'ACTIVE';
    case 'PAYMENT_FAILED':
      return 'PAST_DUE';
    case 'PAYMENT_RECOVERED':
      return 'ACTIVE';
    case 'PLAN_CHANGED':
      return null;
    case 'SUBSCRIPTION_CANCELED':
      return 'CANCELED';
    case 'SUBSCRIPTION_EXPIRED':
      return 'EXPIRED';
    case 'SUBSCRIPTION_REVOKED':
      return 'REVOKED';
  }
}

export function assertValidTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
  if (from === to) return; // idempotent re-application of the same state
  if (!SUBSCRIPTION_TRANSITIONS[from].includes(to)) {
    throw unprocessableEntity(
      `Invalid subscription transition: ${from} → ${to}. Terminal states cannot be left.`,
    );
  }
}

export interface ApplyEventInput {
  userId: string;
  provider: SubscriptionProvider;
  event: NormalizedProviderEvent;
}

export interface SubscriptionState {
  id: string;
  userId: string;
  planId: string;
  provider: SubscriptionProvider;
  status: SubscriptionStatus;
  externalSubscriptionId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const stateSelect = {
  id: true,
  userId: true,
  planId: true,
  provider: true,
  status: true,
  externalSubscriptionId: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  canceledAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type StateRow = {
  id: string;
  userId: string;
  planId: string;
  provider: SubscriptionProvider;
  status: SubscriptionStatus;
  externalSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toState(row: StateRow): SubscriptionState {
  return {
    id: row.id,
    userId: row.userId,
    planId: row.planId,
    provider: row.provider,
    status: row.status,
    externalSubscriptionId: row.externalSubscriptionId,
    currentPeriodStart: row.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    canceledAt: row.canceledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requirePlan(planCode: string, db: PrismaClient | Prisma.TransactionClient) {
  const plan = await db.plan.findUnique({ where: { id: planCode } });
  if (!plan || !plan.active) {
    throw unprocessableEntity(`Unknown or inactive plan: ${planCode}.`);
  }
  return plan;
}

/**
 * Apply one normalized provider event. Idempotent on
 * (provider, providerEventId): duplicate deliveries return the current
 * subscription state and write nothing new.
 *
 * Throws 404 when the event targets an unknown subscription and is not a
 * creating event; 422 on invalid transitions or unknown plans; 409 on a
 * conflicting concurrent insert (unique violation) — the caller may retry
 * and will then hit the idempotent path.
 */
export async function applyProviderEvent(
  input: ApplyEventInput,
  db: PrismaClient,
): Promise<{ state: SubscriptionState; duplicate: boolean }> {
  const { userId, provider, event } = input;

  // Fast idempotency check before doing any work.
  const existingEvent = await db.subscriptionEvent.findUnique({
    where: { provider_providerEventId: { provider, providerEventId: event.providerEventId } },
    select: { subscriptionId: true },
  });
  if (existingEvent) {
    const sub = await db.subscription.findUniqueOrThrow({
      where: { id: existingEvent.subscriptionId },
      select: stateSelect,
    });
    return { state: toState(sub), duplicate: true };
  }

  const targetStatus = targetStatusFor(event.eventType);

  try {
    return await db.$transaction(async (tx) => {
      // Re-check inside the transaction: closes the check-then-act race.
      const dupe = await tx.subscriptionEvent.findUnique({
        where: { provider_providerEventId: { provider, providerEventId: event.providerEventId } },
        select: { subscriptionId: true },
      });
      if (dupe) {
        const sub = await tx.subscription.findUniqueOrThrow({
          where: { id: dupe.subscriptionId },
          select: stateSelect,
        });
        return { state: toState(sub), duplicate: true };
      }

      let sub = await tx.subscription.findUnique({
        where: {
          provider_externalSubscriptionId: {
            provider,
            externalSubscriptionId: event.externalSubscriptionId,
          },
        },
        select: stateSelect,
      });

      if (!sub) {
        if (!CREATING_EVENTS.includes(event.eventType)) {
          throw notFound(
            `No subscription found for provider event ${event.providerEventId} ` +
              `(${event.externalSubscriptionId}); only start events can create one.`,
          );
        }
        if (!event.planCode) {
          throw unprocessableEntity('planCode is required to start a subscription.');
        }
        const plan = await requirePlan(event.planCode, tx);
        sub = await tx.subscription.create({
          data: {
            userId,
            planId: plan.id,
            provider,
            status: targetStatus ?? 'ACTIVE',
            externalSubscriptionId: event.externalSubscriptionId,
            currentPeriodStart: event.periodStart ?? null,
            currentPeriodEnd: event.periodEnd ?? null,
            canceledAt: null,
          },
          select: stateSelect,
        });
      } else {
        // The event must belong to the same user that owns the subscription.
        if (sub.userId !== userId) {
          throw conflict('Provider event does not match this subscription\u2019s owner.');
        }
        if (event.planCode && event.planCode !== sub.planId) {
          await requirePlan(event.planCode, tx);
        }
        const statusFrom = sub.status;
        const statusTo = targetStatus ?? statusFrom;
        assertValidTransition(statusFrom, statusTo);
        sub = await tx.subscription.update({
          where: { id: sub.id },
          data: {
            ...(event.planCode && event.planCode !== sub.planId ? { planId: event.planCode } : {}),
            status: statusTo,
            ...(event.periodStart !== undefined ? { currentPeriodStart: event.periodStart } : {}),
            ...(event.periodEnd !== undefined ? { currentPeriodEnd: event.periodEnd } : {}),
            ...(statusTo === 'CANCELED' && statusFrom !== 'CANCELED'
              ? { canceledAt: new Date() }
              : {}),
          },
          select: stateSelect,
        });
        // Append history (facts only — no card data, no secrets).
        await tx.subscriptionEvent.create({
          data: {
            subscriptionId: sub.id,
            provider,
            providerEventId: event.providerEventId,
            eventType: event.eventType,
            statusFrom,
            statusTo,
            payload: {
              planCode: event.planCode ?? sub.planId,
              periodStart: event.periodStart?.toISOString() ?? null,
              periodEnd: event.periodEnd?.toISOString() ?? null,
              ...sanitizeFacts(event.facts),
            },
          },
        });
        return { state: toState(sub), duplicate: false };
      }

      // History row for the creating event.
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: sub.id,
          provider,
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          statusFrom: null,
          statusTo: sub.status,
          payload: {
            planCode: sub.planId,
            periodStart: event.periodStart?.toISOString() ?? null,
            periodEnd: event.periodEnd?.toISOString() ?? null,
            ...sanitizeFacts(event.facts),
          },
        },
      });
      return { state: toState(sub), duplicate: false };
    });
  } catch (error) {
    // A concurrent duplicate insert raced us: the unique constraint fired.
    // Re-read under the idempotent path so the caller sees one history row.
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    ) {
      const dupe = await db.subscriptionEvent.findUnique({
        where: { provider_providerEventId: { provider, providerEventId: event.providerEventId } },
        select: { subscriptionId: true },
      });
      if (dupe) {
        const sub = await db.subscription.findUniqueOrThrow({
          where: { id: dupe.subscriptionId },
          select: stateSelect,
        });
        return { state: toState(sub), duplicate: true };
      }
    }
    throw error;
  }
}

/** Latest subscription for a user (the one that drives entitlement). */
export async function getCurrentSubscription(
  userId: string,
  db: PrismaClient,
): Promise<SubscriptionState | null> {
  const sub = await db.subscription.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: stateSelect,
  });
  return sub ? toState(sub) : null;
}

export interface SubscriptionHistoryEntry {
  id: string;
  eventType: SubscriptionEventType;
  statusFrom: SubscriptionStatus | null;
  statusTo: SubscriptionStatus | null;
  payload: Prisma.JsonValue;
  createdAt: string;
}

/** Append-only history for one subscription, newest last. */
export async function getSubscriptionHistory(
  subscriptionId: string,
  db: PrismaClient,
  limit = 50,
): Promise<SubscriptionHistoryEntry[]> {
  const rows = await db.subscriptionEvent.findMany({
    where: { subscriptionId },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: {
      id: true,
      eventType: true,
      statusFrom: true,
      statusTo: true,
      payload: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    statusFrom: r.statusFrom,
    statusTo: r.statusTo,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
  }));
}
