// Admin V2 — Billing management: plan catalog and promo codes.
// Backed by /v1/admin/billing/* (requires `subscriptions.manage`).
// The purchase kill switch and grace period are platform settings
// (billing.*), edited on the Platform Config page.

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import {
  createPlan,
  createPromo,
  deletePromo,
  listPlans,
  listPromos,
  setPlanActive,
  setPromoActive,
  updatePlan,
  validatePromo,
  type AdminPlan,
  type AdminPromo,
  type PlanInput,
  type PromoInput,
  type PromoValidation,
} from '../api/billing';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { useConfirm } from '../components/ConfirmDialog';
import { formatDate, formatMoney } from '../utils/format';

const INTERVAL_LABELS: Record<string, string> = { WEEK: 'week', MONTH: 'month', YEAR: 'year' };

function planPrice(p: AdminPlan): string {
  const base = formatMoney(p.priceCents, p.currency);
  const per = p.intervalCount > 1 ? `${p.intervalCount} ` : '';
  return `${base} / ${per}${INTERVAL_LABELS[p.billingInterval] ?? p.billingInterval}`;
}

export function BillingCenter(): React.ReactNode {
  const { client } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [promos, setPromos] = useState<AdminPromo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editingPlan, setEditingPlan] = useState<AdminPlan | 'new' | null>(null);
  const [creatingPromo, setCreatingPromo] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, pr] = await Promise.all([listPlans(client), listPromos(client)]);
      setPlans(p);
      setPromos(pr);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runAction(fn: () => Promise<void>) {
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed.');
    }
  }

  async function handlePlanToggle(plan: AdminPlan) {
    const next = !plan.active;
    if (!next && plan.payingSubscribers > 0) {
      // The server also refuses this; surface it early with the count.
      setActionError(
        `Cannot deactivate "${plan.name}": ${plan.payingSubscribers} paying subscriber(s) still on it.`,
      );
      return;
    }
    const ok = await confirm({
      title: next ? 'Activate plan' : 'Deactivate plan',
      message: next
        ? `Activate "${plan.name}"? It becomes purchasable again.`
        : `Deactivate "${plan.name}"? New purchases stop; existing subscribers keep their plan.`,
      confirmLabel: next ? 'Activate' : 'Deactivate',
    });
    if (ok) void runAction(() => setPlanActive(client, plan.id, next).then(() => {}));
  }

  async function handlePromoToggle(promo: AdminPromo) {
    const next = !promo.active;
    const ok = await confirm({
      title: next ? 'Activate promo code' : 'Deactivate promo code',
      message: next
        ? `Activate promo code "${promo.code}"?`
        : `Deactivate promo code "${promo.code}"? It can no longer be redeemed.`,
      confirmLabel: next ? 'Activate' : 'Deactivate',
    });
    if (ok) void runAction(() => setPromoActive(client, promo.id, next).then(() => {}));
  }

  async function handlePromoDelete(promo: AdminPromo) {
    const ok = await confirm({
      title: 'Delete promo code',
      message: `Delete promo code "${promo.code}"? Only possible because it was never redeemed.`,
      confirmLabel: 'Delete',
    });
    if (ok) void runAction(() => deletePromo(client, promo.id));
  }

  if (loading) return <LoadingState label="Loading billing…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;

  return (
    <div>
      {dialog}
      {actionError && (
        <div className="alert alert-error" role="alert">
          {actionError}
          <button type="button" className="btn btn-sm" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="page-header">
        <h2>Plans</h2>
        <button type="button" className="btn btn-primary" onClick={() => setEditingPlan('new')}>
          New plan
        </button>
      </div>
      {!plans?.length ? (
        <EmptyState message="No plans yet." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Plan</th>
                <th>Price</th>
                <th>Trial</th>
                <th>Store products</th>
                <th>Paying</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    <br />
                    <span className="mono muted">{p.id}</span>
                    <span className="muted"> · {p.planType}</span>
                  </td>
                  <td>{planPrice(p)}</td>
                  <td>{p.trialDays > 0 ? `${p.trialDays} days` : '—'}</td>
                  <td>
                    <StoreProductBadges plan={p} />
                  </td>
                  <td>{p.payingSubscribers}</td>
                  <td>
                    {p.active ? (
                      <span className="badge badge-green">Active</span>
                    ) : (
                      <span className="badge badge-gray">Inactive</span>
                    )}
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => setEditingPlan(p)}>
                      Edit
                    </button>{' '}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void handlePlanToggle(p)}
                    >
                      {p.active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="page-header" style={{ marginTop: '2rem' }}>
        <h2>Promo codes</h2>
        <button type="button" className="btn btn-primary" onClick={() => setCreatingPromo(true)}>
          New promo code
        </button>
      </div>
      {!promos?.length ? (
        <EmptyState message="No promo codes yet." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Discount</th>
                <th>Redeemed</th>
                <th>Validity</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {promos.map((pr) => (
                <tr key={pr.id}>
                  <td>
                    <strong className="mono">{pr.code}</strong>
                    {pr.description && (
                      <>
                        <br />
                        <span className="muted">{pr.description}</span>
                      </>
                    )}
                  </td>
                  <td>
                    {pr.percentOff !== null
                      ? `${pr.percentOff}% off`
                      : formatMoney(pr.amountOffCents ?? 0, pr.currency) + ' off'}
                  </td>
                  <td>
                    {pr.redeemedCount}
                    {pr.maxRedemptions !== null ? ` / ${pr.maxRedemptions}` : ' / ∞'}
                  </td>
                  <td>
                    {pr.startsAt ? formatDate(pr.startsAt) : '—'}
                    {' → '}
                    {pr.expiresAt ? formatDate(pr.expiresAt) : 'no expiry'}
                    {pr.applicablePlans.length > 0 && (
                      <>
                        <br />
                        <span className="muted">{pr.applicablePlans.join(', ')}</span>
                      </>
                    )}
                  </td>
                  <td>
                    {pr.active ? (
                      <span className="badge badge-green">Active</span>
                    ) : (
                      <span className="badge badge-gray">Inactive</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void handlePromoToggle(pr)}
                    >
                      {pr.active ? 'Deactivate' : 'Activate'}
                    </button>{' '}
                    {pr.redeemedCount === 0 && (
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => void handlePromoDelete(pr)}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PromoValidator plans={plans ?? []} />

      {editingPlan && (
        <PlanForm
          plan={editingPlan === 'new' ? null : editingPlan}
          onClose={() => setEditingPlan(null)}
          onSaved={() => {
            setEditingPlan(null);
            void load();
          }}
        />
      )}
      {creatingPromo && (
        <PromoForm
          plans={plans ?? []}
          onClose={() => setCreatingPromo(false)}
          onSaved={() => {
            setCreatingPromo(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function StoreProductBadges({ plan }: { plan: AdminPlan }): React.ReactNode {
  const badges: React.ReactNode[] = [];
  if (plan.appleProductId)
    badges.push(
      <span key="a" className="badge badge-blue" title={plan.appleProductId}>
        App Store
      </span>,
    );
  if (plan.googleProductId)
    badges.push(
      <span key="g" className="badge badge-green" title={plan.googleProductId}>
        Google Play
      </span>,
    );
  if (plan.devProductId)
    badges.push(
      <span key="d" className="badge badge-gray" title={plan.devProductId}>
        DEV
      </span>,
    );
  return badges.length > 0 ? (
    <>
      {badges.reduce((acc, b, i) => (
        <>
          {acc}
          {i > 0 && ' '}
          {b}
        </>
      ))}
    </>
  ) : (
    <span className="muted">—</span>
  );
}

// -- Plan form ---------------------------------------------------------------

function PlanForm({
  plan,
  onClose,
  onSaved,
}: {
  plan: AdminPlan | null;
  onClose: () => void;
  onSaved: () => void;
}): React.ReactNode {
  const { client } = useAuth();
  const [id, setId] = useState(plan?.id ?? '');
  const [name, setName] = useState(plan?.name ?? '');
  const [planType, setPlanType] = useState<'INDIVIDUAL' | 'FAMILY' | 'STUDENT'>(
    plan?.planType ?? 'INDIVIDUAL',
  );
  const [price, setPrice] = useState(plan ? (plan.priceCents / 100).toFixed(2) : '9.99');
  const [currency, setCurrency] = useState(plan?.currency ?? 'USD');
  const [billingInterval, setBillingInterval] = useState<'WEEK' | 'MONTH' | 'YEAR'>(
    plan?.billingInterval ?? 'MONTH',
  );
  const [intervalCount, setIntervalCount] = useState(String(plan?.intervalCount ?? 1));
  const [trialDays, setTrialDays] = useState(String(plan?.trialDays ?? 0));
  const [features, setFeatures] = useState((plan?.features ?? []).join('\n'));
  const [sortOrder, setSortOrder] = useState(String(plan?.sortOrder ?? 0));
  const [appleProductId, setAppleProductId] = useState(plan?.appleProductId ?? '');
  const [googleProductId, setGoogleProductId] = useState(plan?.googleProductId ?? '');
  const [devProductId, setDevProductId] = useState(plan?.devProductId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const priceCents = Math.round(Number.parseFloat(price) * 100);
    if (!Number.isFinite(priceCents) || priceCents < 0) {
      setError('Price must be a non-negative number.');
      return;
    }
    const input: PlanInput = {
      name: name.trim(),
      planType: planType as PlanInput['planType'],
      priceCents,
      currency: currency.trim().toUpperCase(),
      billingInterval: billingInterval as PlanInput['billingInterval'],
      intervalCount: Number.parseInt(intervalCount, 10) || 1,
      trialDays: Number.parseInt(trialDays, 10) || 0,
      features: features
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean),
      sortOrder: Number.parseInt(sortOrder, 10) || 0,
      appleProductId: appleProductId.trim() || null,
      googleProductId: googleProductId.trim() || null,
      devProductId: devProductId.trim() || null,
    };
    setSaving(true);
    try {
      if (plan) {
        await updatePlan(client, plan.id, input);
      } else {
        await createPlan(client, { ...input, id: id.trim() });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()} role="dialog">
        <h2>{plan ? `Edit plan "${plan.name}"` : 'New plan'}</h2>
        <form onSubmit={(e) => void handleSubmit(e)}>
          {!plan && (
            <div className="field">
              <label htmlFor="plan-id">Plan ID (slug, immutable)</label>
              <input
                id="plan-id"
                type="text"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="premium_annual"
                required
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="plan-name">Name</label>
            <input
              id="plan-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="form-row">
            <div className="field">
              <label htmlFor="plan-type">Type</label>
              <select
                id="plan-type"
                value={planType}
                onChange={(e) => setPlanType(e.target.value as 'INDIVIDUAL' | 'FAMILY' | 'STUDENT')}
              >
                <option value="INDIVIDUAL">Individual</option>
                <option value="FAMILY">Family</option>
                <option value="STUDENT">Student</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="plan-price">Price</label>
              <input
                id="plan-price"
                type="number"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="plan-currency">Currency</label>
              <input
                id="plan-currency"
                type="text"
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label htmlFor="plan-interval">Bills every</label>
              <select
                id="plan-interval"
                value={billingInterval}
                onChange={(e) => setBillingInterval(e.target.value as 'WEEK' | 'MONTH' | 'YEAR')}
              >
                <option value="WEEK">Week</option>
                <option value="MONTH">Month</option>
                <option value="YEAR">Year</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="plan-interval-count">Interval count</label>
              <input
                id="plan-interval-count"
                type="number"
                min="1"
                max="52"
                value={intervalCount}
                onChange={(e) => setIntervalCount(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="plan-trial">Trial days</label>
              <input
                id="plan-trial"
                type="number"
                min="0"
                max="365"
                value={trialDays}
                onChange={(e) => setTrialDays(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="plan-sort">Sort order</label>
              <input
                id="plan-sort"
                type="number"
                min="0"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="plan-features">Features (one per line)</label>
            <textarea
              id="plan-features"
              rows={4}
              value={features}
              onChange={(e) => setFeatures(e.target.value)}
              placeholder={'Ad-free listening\nOffline downloads'}
            />
          </div>
          <div className="field">
            <label htmlFor="plan-apple">App Store product ID</label>
            <input
              id="plan-apple"
              type="text"
              value={appleProductId}
              onChange={(e) => setAppleProductId(e.target.value)}
              placeholder="com.waveform.premium.individual"
            />
          </div>
          <div className="field">
            <label htmlFor="plan-google">Google Play product ID</label>
            <input
              id="plan-google"
              type="text"
              value={googleProductId}
              onChange={(e) => setGoogleProductId(e.target.value)}
              placeholder="premium_individual"
            />
          </div>
          <div className="field">
            <label htmlFor="plan-dev">DEV product ID</label>
            <input
              id="plan-dev"
              type="text"
              value={devProductId}
              onChange={(e) => setDevProductId(e.target.value)}
              placeholder="dev.waveform.premium.individual"
            />
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : plan ? 'Save changes' : 'Create plan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -- Promo form ----------------------------------------------------------------

function PromoForm({
  plans,
  onClose,
  onSaved,
}: {
  plans: AdminPlan[];
  onClose: () => void;
  onSaved: () => void;
}): React.ReactNode {
  const { client } = useAuth();
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [discountType, setDiscountType] = useState<'percent' | 'amount'>('percent');
  const [percentOff, setPercentOff] = useState('20');
  const [amountOff, setAmountOff] = useState('5.00');
  const [currency, setCurrency] = useState('USD');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [applicablePlans, setApplicablePlans] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function togglePlan(planId: string) {
    setApplicablePlans((prev) =>
      prev.includes(planId) ? prev.filter((p) => p !== planId) : [...prev, planId],
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const input: PromoInput = {
      code: code.trim().toUpperCase(),
      description: description.trim(),
      currency: currency.trim().toUpperCase(),
      applicablePlans,
    };
    if (discountType === 'percent') {
      const pct = Number.parseInt(percentOff, 10);
      if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
        setError('Percent off must be between 1 and 100.');
        return;
      }
      input.percentOff = pct;
    } else {
      const cents = Math.round(Number.parseFloat(amountOff) * 100);
      if (!Number.isFinite(cents) || cents <= 0) {
        setError('Amount off must be a positive number.');
        return;
      }
      input.amountOffCents = cents;
    }
    if (maxRedemptions.trim()) {
      const max = Number.parseInt(maxRedemptions, 10);
      if (!Number.isInteger(max) || max <= 0) {
        setError('Max redemptions must be a positive integer.');
        return;
      }
      input.maxRedemptions = max;
    }
    if (startsAt) input.startsAt = new Date(startsAt).toISOString();
    if (expiresAt) input.expiresAt = new Date(expiresAt).toISOString();
    setSaving(true);
    try {
      await createPromo(client, input);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()} role="dialog">
        <h2>New promo code</h2>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="form-row">
            <div className="field">
              <label htmlFor="promo-code">Code</label>
              <input
                id="promo-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="WELCOME20"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="promo-kind">Discount type</label>
              <select
                id="promo-kind"
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value as 'percent' | 'amount')}
              >
                <option value="percent">Percent off</option>
                <option value="amount">Amount off</option>
              </select>
            </div>
            {discountType === 'percent' ? (
              <div className="field">
                <label htmlFor="promo-pct">Percent off</label>
                <input
                  id="promo-pct"
                  type="number"
                  min="1"
                  max="100"
                  value={percentOff}
                  onChange={(e) => setPercentOff(e.target.value)}
                  required
                />
              </div>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="promo-amt">Amount off</label>
                  <input
                    id="promo-amt"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={amountOff}
                    onChange={(e) => setAmountOff(e.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="promo-cur">Currency</label>
                  <input
                    id="promo-cur"
                    type="text"
                    maxLength={3}
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    required
                  />
                </div>
              </>
            )}
          </div>
          <div className="field">
            <label htmlFor="promo-desc">Description</label>
            <input
              id="promo-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Welcome offer for new subscribers"
            />
          </div>
          <div className="form-row">
            <div className="field">
              <label htmlFor="promo-max">Max redemptions (blank = unlimited)</label>
              <input
                id="promo-max"
                type="number"
                min="1"
                value={maxRedemptions}
                onChange={(e) => setMaxRedemptions(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="promo-start">Starts at</label>
              <input
                id="promo-start"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="promo-end">Expires at</label>
              <input
                id="promo-end"
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label>Applies to plans (none selected = all plans)</label>
            <div className="checkbox-list">
              {plans.map((p) => (
                <label key={p.id} className="checkbox">
                  <input
                    type="checkbox"
                    checked={applicablePlans.includes(p.id)}
                    onChange={() => togglePlan(p.id)}
                  />
                  {p.name}
                </label>
              ))}
            </div>
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Create promo code'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -- Promo validator -------------------------------------------------------------

function PromoValidator({ plans }: { plans: AdminPlan[] }): React.ReactNode {
  const { client } = useAuth();
  const [code, setCode] = useState('');
  const [userId, setUserId] = useState('');
  const [planId, setPlanId] = useState('');
  const [result, setResult] = useState<PromoValidation | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCheck(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setChecking(true);
    try {
      setResult(await validatePromo(client, code.trim(), userId.trim(), planId || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation failed.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: '2rem' }}>
      <h2>Validate a promo code</h2>
      <p className="muted">Preview whether a code is redeemable for a user without consuming it.</p>
      <form onSubmit={(e) => void handleCheck(e)}>
        <div className="toolbar">
          <div className="field">
            <label htmlFor="val-code">Code</label>
            <input
              id="val-code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="val-user">User ID</label>
            <input
              id="val-user"
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="uuid"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="val-plan">Plan (optional)</label>
            <select id="val-plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">Any plan</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn" disabled={checking}>
            {checking ? 'Checking…' : 'Validate'}
          </button>
        </div>
      </form>
      {error && <p className="form-error">{error}</p>}
      {result && (
        <p>
          {result.valid ? (
            <span className="badge badge-green">Valid</span>
          ) : (
            <span className="badge badge-red">Invalid: {result.reason}</span>
          )}
        </p>
      )}
    </div>
  );
}
