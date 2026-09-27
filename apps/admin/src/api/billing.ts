// Admin V2 — billing management API client. Plans and promo codes,
// backed by /v1/admin/billing/* (requires `subscriptions.manage`).

import type { ApiClient } from './client';

export interface AdminPlan {
  id: string;
  name: string;
  planType: 'INDIVIDUAL' | 'FAMILY' | 'STUDENT';
  active: boolean;
  priceCents: number;
  currency: string;
  billingInterval: 'WEEK' | 'MONTH' | 'YEAR';
  intervalCount: number;
  trialDays: number;
  features: string[];
  sortOrder: number;
  appleProductId: string | null;
  googleProductId: string | null;
  devProductId: string | null;
  payingSubscribers: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlanInput {
  id?: string;
  name: string;
  planType: 'INDIVIDUAL' | 'FAMILY' | 'STUDENT';
  priceCents: number;
  currency: string;
  billingInterval: 'WEEK' | 'MONTH' | 'YEAR';
  intervalCount?: number;
  trialDays?: number;
  features?: string[];
  sortOrder?: number;
  appleProductId?: string | null;
  googleProductId?: string | null;
  devProductId?: string | null;
}

export interface AdminPromo {
  id: string;
  code: string;
  description: string;
  percentOff: number | null;
  amountOffCents: number | null;
  currency: string;
  maxRedemptions: number | null;
  redeemedCount: number;
  startsAt: string | null;
  expiresAt: string | null;
  active: boolean;
  applicablePlans: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PromoInput {
  code: string;
  description?: string;
  percentOff?: number;
  amountOffCents?: number;
  currency?: string;
  maxRedemptions?: number | null;
  startsAt?: string | null;
  expiresAt?: string | null;
  applicablePlans?: string[];
}

export interface PromoValidation {
  valid: boolean;
  reason?: string;
  promo?: AdminPromo;
}

export function listPlans(client: ApiClient): Promise<AdminPlan[]> {
  return client.get<AdminPlan[]>('/v1/admin/billing/plans');
}

export function createPlan(
  client: ApiClient,
  input: PlanInput & { id: string },
): Promise<AdminPlan> {
  return client.post<AdminPlan>('/v1/admin/billing/plans', input);
}

export function updatePlan(
  client: ApiClient,
  id: string,
  input: Partial<PlanInput>,
): Promise<AdminPlan> {
  return client.patch<AdminPlan>(`/v1/admin/billing/plans/${encodeURIComponent(id)}`, input);
}

export function setPlanActive(client: ApiClient, id: string, active: boolean): Promise<AdminPlan> {
  return client.post<AdminPlan>(
    `/v1/admin/billing/plans/${encodeURIComponent(id)}/${active ? 'activate' : 'deactivate'}`,
    {},
  );
}

export function listPromos(client: ApiClient): Promise<AdminPromo[]> {
  return client.get<AdminPromo[]>('/v1/admin/billing/promos');
}

export function createPromo(client: ApiClient, input: PromoInput): Promise<AdminPromo> {
  return client.post<AdminPromo>('/v1/admin/billing/promos', input);
}

export function setPromoActive(
  client: ApiClient,
  id: string,
  active: boolean,
): Promise<AdminPromo> {
  return client.post<AdminPromo>(
    `/v1/admin/billing/promos/${id}/${active ? 'activate' : 'deactivate'}`,
    {},
  );
}

export function deletePromo(client: ApiClient, id: string): Promise<void> {
  return client.delete<void>(`/v1/admin/billing/promos/${id}`);
}

export function validatePromo(
  client: ApiClient,
  code: string,
  userId: string,
  planId?: string,
): Promise<PromoValidation> {
  return client.post<PromoValidation>('/v1/admin/billing/promos/validate', {
    code,
    userId,
    planId,
  });
}
