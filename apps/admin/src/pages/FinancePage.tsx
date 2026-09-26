// Admin V2 — Finance: three separate centers.
// - Subscriptions (finance.view): aggregates from
//   GET /v1/admin/finance/subscriptions; per-user overrides, trials, and
//   chargebacks live in UserDetail on the Users page.
// - Commerce (finance.view): aggregates from
//   GET /v1/admin/finance/commerce; the order list needs commerce.manage.
// - Royalties (finance.view): payout runs + totals from
//   GET /v1/admin/finance/royalties.

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/PermissionsContext';
import { getFinanceCommerce, getFinanceRoyalties, getFinanceSubscriptions } from '../api/ops';
import type {
  FinanceCommerce,
  FinanceRoyalties,
  FinanceSubscriptions,
  PermissionKey,
} from '../api/types';
import type { AdminOrder } from '../api/commerce';
import { listAdminOrders as listCommerceOrders } from '../api/commerce';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { RequirePermission } from '../components/PermissionGate';
import { Pagination } from '../components/Pagination';
import { formatDate, formatMoney } from '../utils/format';

type Tab = 'subscriptions' | 'commerce' | 'royalties';

export function FinancePage(): React.ReactNode {
  const { can } = usePermissions();
  // The backend guards all three finance centers with `finance.view`;
  // there are no per-center permission keys.
  const [tab, setTab] = useState<Tab>('subscriptions');
  const tabs: { id: Tab; label: string; perm: PermissionKey }[] = [
    { id: 'subscriptions', label: 'Subscriptions', perm: 'finance.view' },
    { id: 'commerce', label: 'Commerce', perm: 'finance.view' },
    { id: 'royalties', label: 'Royalties', perm: 'finance.view' },
  ];
  return (
    <div>
      <div className="page-header">
        <h1>Finance</h1>
      </div>
      <div className="tab-bar" role="tablist">
        {tabs
          .filter((t) => can(t.perm))
          .map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'tab active' : 'tab'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
      </div>
      {tab === 'subscriptions' && (
        <RequirePermission perm="finance.view">
          <SubscriptionsCenter />
        </RequirePermission>
      )}
      {tab === 'commerce' && (
        <RequirePermission perm="finance.view">
          <CommerceCenter />
        </RequirePermission>
      )}
      {tab === 'royalties' && (
        <RequirePermission perm="finance.view">
          <RoyaltiesCenter />
        </RequirePermission>
      )}
    </div>
  );
}

// -- Subscriptions --------------------------------------------------------

function SubscriptionsCenter(): React.ReactNode {
  const { client } = useAuth();
  const { can } = usePermissions();
  const [data, setData] = useState<FinanceSubscriptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getFinanceSubscriptions(client));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState label="Loading subscription finance…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!data) return <EmptyState message="No subscription data." />;

  return (
    <section aria-label="Subscriptions">
      <div className="stat-grid">
        <div className="card stat-card">
          <p className="stat-value">{data.trialing}</p>
          <p className="stat-label">Trialing now</p>
        </div>
        <div className="card stat-card">
          <p className="stat-value">{data.chargebacks.count}</p>
          <p className="stat-label">Chargebacks</p>
        </div>
        <div className="card stat-card">
          <p className="stat-value">{formatMoney(data.chargebacks.amountCents, 'USD')}</p>
          <p className="stat-label">Chargeback volume</p>
        </div>
      </div>
      <div className="card">
        <h2>By status</h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Count</th>
              </tr>
            </thead>
            <tbody>
              {data.byStatus.map((row) => (
                <tr key={row.status}>
                  <td>{row.status}</td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h2>By plan</h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Count</th>
              </tr>
            </thead>
            <tbody>
              {data.byPlan.map((row) => (
                <tr key={row.planId}>
                  <td>
                    {row.planName} <span className="mono muted">{row.planId}</span>
                  </td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h2>Recent subscription events</h2>
        {data.recentEvents.length === 0 ? (
          <EmptyState message="No recent events." />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Event</th>
                  <th scope="col">Transition</th>
                </tr>
              </thead>
              <tbody>
                {data.recentEvents.map((event) => (
                  <tr key={event.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(event.createdAt)}</td>
                    <td className="mono">{event.eventType}</td>
                    <td className="mono">
                      {event.statusFrom ?? '—'} → {event.statusTo ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {can('subscriptions.manage') && (
        <p className="muted" style={{ fontSize: 13 }}>
          Overrides, trials, and chargebacks are handled per-user on the Users page.
        </p>
      )}
    </section>
  );
}

// -- Commerce ---------------------------------------------------------------

function CommerceCenter(): React.ReactNode {
  const { client } = useAuth();
  const { can } = usePermissions();
  const canManageOrders = can('commerce.manage');
  const [overview, setOverview] = useState<FinanceCommerce | null>(null);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [pagination, setPagination] = useState<{
    page: number;
    totalPages: number;
  } | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const finance = await getFinanceCommerce(client);
      setOverview(finance);
      // The order list lives behind commerce.manage (the admin commerce
      // endpoints), while the finance aggregate needs finance.view.
      if (canManageOrders) {
        const orderPage = await listCommerceOrders(client, {
          page,
          limit: 20,
          status: (statusFilter || undefined) as AdminOrder['status'] | undefined,
        });
        setOrders(orderPage.data);
        setPagination(orderPage.pagination);
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client, page, statusFilter, canManageOrders]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState label="Loading commerce finance…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!overview) return <EmptyState message="No commerce data." />;

  return (
    <section aria-label="Commerce">
      <div className="stat-grid">
        <div className="card stat-card">
          <p className="stat-value">{formatMoney(overview.grossCents, 'USD')}</p>
          <p className="stat-label">Gross</p>
        </div>
        <div className="card stat-card">
          <p className="stat-value">{formatMoney(overview.refundedCents, 'USD')}</p>
          <p className="stat-label">Refunded</p>
        </div>
        <div className="card stat-card">
          <p className="stat-value">{formatMoney(overview.netCents, 'USD')}</p>
          <p className="stat-label">Net</p>
        </div>
      </div>
      <div className="card">
        <h2>Orders by status</h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Count</th>
              </tr>
            </thead>
            <tbody>
              {overview.byStatus.map((row) => (
                <tr key={row.status}>
                  <td>{row.status}</td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h2>Recent refunds</h2>
        {overview.recentRefunds.length === 0 ? (
          <p className="muted">No refunds recorded.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Order</th>
                  <th scope="col">Amount</th>
                </tr>
              </thead>
              <tbody>
                {overview.recentRefunds.map((refund) => (
                  <tr key={refund.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(refund.createdAt)}</td>
                    <td className="mono">{refund.orderId.slice(0, 8)}…</td>
                    <td>{formatMoney(refund.amountCents, refund.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <h2>Orders</h2>
        {!canManageOrders ? (
          <p className="muted">
            Order management requires the <span className="mono">commerce.manage</span> permission.
          </p>
        ) : (
          <>
            <div className="toolbar">
              <div className="field">
                <label htmlFor="order-status-filter">Status</label>
                <select
                  id="order-status-filter"
                  value={statusFilter}
                  onChange={(event) => {
                    setStatusFilter(event.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">All</option>
                  {[
                    'PENDING_PAYMENT',
                    'PAID',
                    'PROCESSING',
                    'SHIPPED',
                    'DELIVERED',
                    'CANCELED',
                    'REFUNDED',
                  ].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {orders.length === 0 ? (
              <EmptyState message="No orders." />
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Order #</th>
                        <th scope="col">Status</th>
                        <th scope="col">Total</th>
                        <th scope="col">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((order) => (
                        <tr key={order.id}>
                          <td className="mono">{order.orderNumber}</td>
                          <td>{order.status}</td>
                          <td>{formatMoney(order.totalCents, order.currency)}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{formatDate(order.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {pagination && (
                  <Pagination
                    pagination={{ page, limit: 20, total: 0, totalPages: pagination.totalPages }}
                    onPage={setPage}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// -- Royalties ----------------------------------------------------------------

function RoyaltiesCenter(): React.ReactNode {
  const { client } = useAuth();
  const [data, setData] = useState<FinanceRoyalties | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getFinanceRoyalties(client));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState label="Loading royalty finance…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!data) return <EmptyState message="No royalty data." />;

  return (
    <section aria-label="Royalties">
      <div className="stat-grid">
        <div className="card stat-card">
          <p className="stat-value">{data.totals.runs}</p>
          <p className="stat-label">Payout runs</p>
        </div>
        <div className="card stat-card">
          <p className="stat-value">{data.totals.allocated}</p>
          <p className="stat-label">Total allocated</p>
        </div>
        <div className="card stat-card">
          <p className="stat-value">{data.totals.adjustments}</p>
          <p className="stat-label">Adjustments</p>
        </div>
      </div>
      <div className="card">
        <h2>Payout runs</h2>
        {data.runs.length === 0 ? (
          <EmptyState message="No payout runs." />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Status</th>
                  <th scope="col">Royalty pool</th>
                  <th scope="col">Allocated</th>
                  <th scope="col">Residual</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((run) => (
                  <tr key={run.id}>
                    <td className="mono">{run.id.slice(0, 8)}…</td>
                    <td>{run.status}</td>
                    <td className="mono">{run.royaltyPool}</td>
                    <td className="mono">{run.totalAllocated}</td>
                    <td className="mono">{run.residualAmount}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(run.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <h2>Recent adjustments</h2>
        {data.recentAdjustments.length === 0 ? (
          <EmptyState message="No adjustments." />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Run</th>
                  <th scope="col">Artist</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.recentAdjustments.map((adj) => (
                  <tr key={adj.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(adj.createdAt)}</td>
                    <td className="mono">{adj.runId.slice(0, 8)}…</td>
                    <td className="mono">{adj.artistId.slice(0, 8)}…</td>
                    <td className="mono">
                      {adj.amount} {adj.currency}
                    </td>
                    <td>{adj.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
