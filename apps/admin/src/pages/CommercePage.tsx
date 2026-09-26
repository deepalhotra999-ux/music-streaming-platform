// Phase 30 — admin commerce: overview stats, store/product moderation,
// and order visibility. All mutations are audited server-side.

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiErrorMessage } from '../api/client';
import {
  getCommerceStats,
  listAdminOrders,
  listAdminProducts,
  listAdminStores,
  moderateProduct,
  moderateStore,
  type AdminOrder,
  type AdminProduct,
  type AdminStore,
  type CommerceStats,
  type OrderStatus,
  type ProductStatus,
  type StoreStatus,
} from '../api/commerce';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { Pagination } from '../components/Pagination';
import { useConfirm } from '../components/ConfirmDialog';
import { formatDate, formatMoney } from '../utils/format';
import { useApiList, type UseApiListResult } from '../hooks/useApiList';

const PAGE_SIZE = 20;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function CommercePage(): React.ReactNode {
  const { client } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [stats, setStats] = useState<CommerceStats | null>(null);
  const [statsError, setStatsError] = useState('');
  const [tab, setTab] = useState<'stores' | 'products' | 'orders'>('stores');
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getCommerceStats(client)
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch((e) => {
        if (!cancelled) setStatsError(apiErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const stores = useApiList<AdminStore, { page?: number; limit?: number }>(
    (q) => listAdminStores(client, q),
    { page: 1, limit: PAGE_SIZE },
  );
  const products = useApiList<AdminProduct, { page?: number; limit?: number }>(
    (q) => listAdminProducts(client, q),
    { page: 1, limit: PAGE_SIZE },
  );
  const orders = useApiList<AdminOrder, { page?: number; limit?: number }>(
    (q) => listAdminOrders(client, q),
    { page: 1, limit: PAGE_SIZE },
  );

  const refresh = useCallback(() => {
    if (tab === 'stores') void stores.reload();
    else if (tab === 'products') void products.reload();
    else void orders.reload();
    getCommerceStats(client).then(setStats).catch(() => {});
  }, [tab, stores, products, orders, client]);

  const onModerateStore = async (store: AdminStore) => {
    const action = store.status === 'SUSPENDED' ? 'reinstate' : 'suspend';
    const ok = await confirm({
      title: `${action === 'suspend' ? 'Suspend' : 'Reinstate'} store`,
      message: `${action === 'suspend' ? 'Suspend' : 'Reinstate'} "${store.name}"?`,
      confirmLabel: action === 'suspend' ? 'Suspend' : 'Reinstate',
    });
    if (!ok) return;
    try {
      await moderateStore(client, store.id, action);
      setActionError('');
      refresh();
    } catch (e) {
      setActionError(apiErrorMessage(e));
    }
  };

  const onModerateProduct = async (product: AdminProduct) => {
    const action = product.status === 'REMOVED' ? 'restore' : 'remove';
    const ok = await confirm({
      title: `${action === 'remove' ? 'Remove' : 'Restore'} product`,
      message: `${action === 'remove' ? 'Remove' : 'Restore'} "${product.title}"?`,
      confirmLabel: action === 'remove' ? 'Remove' : 'Restore',
    });
    if (!ok) return;
    try {
      await moderateProduct(client, product.id, action);
      setActionError('');
      refresh();
    } catch (e) {
      setActionError(apiErrorMessage(e));
    }
  };

  return (
    <div className="page">
      <h1>Commerce</h1>

      {statsError ? (
        <ErrorState error={statsError} onRetry={() => window.location.reload()} />
      ) : !stats ? (
        <LoadingState />
      ) : (
        <div className="stat-grid">
          <Stat label="Stores" value={String(stats.storeCount)} />
          <Stat label="Active stores" value={String(stats.activeStoreCount)} />
          <Stat label="Products" value={String(stats.productCount)} />
          <Stat label="Active products" value={String(stats.activeProductCount)} />
          <Stat label="Orders" value={String(stats.orderCount)} />
          <Stat label="Paid orders" value={String(stats.paidOrderCount)} />
          {Object.entries(stats.grossCentsByCurrency).map(([currency, cents]) => (
            <Stat
              key={`gross-${currency}`}
              label={`Gross (${currency})`}
              value={formatMoney(cents, currency)}
            />
          ))}
          {Object.entries(stats.refundedCentsByCurrency).map(([currency, cents]) => (
            <Stat
              key={`refunded-${currency}`}
              label={`Refunded (${currency})`}
              value={formatMoney(cents, currency)}
            />
          ))}
        </div>
      )}

      {actionError ? <div className="error-banner">{actionError}</div> : null}

      <div className="tabs">
        {(['stores', 'products', 'orders'] as const).map((t) => (
          <button
            key={t}
            className={tab === t ? 'tab active' : 'tab'}
            onClick={() => setTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'stores' && (
        <StoreTable
          list={stores}
          onModerate={(s) => void onModerateStore(s)}
        />
      )}
      {tab === 'products' && (
        <ProductTable
          list={products}
          onModerate={(p) => void onModerateProduct(p)}
        />
      )}
      {tab === 'orders' && <OrderTable list={orders} />}
      {dialog}
    </div>
  );
}

function StoreTable({
  list,
  onModerate,
}: {
  list: UseApiListResult<AdminStore, { page?: number; limit?: number }>;
  onModerate: (s: AdminStore) => void;
}) {
  if (list.loading) return <LoadingState />;
  if (list.error)
    return <ErrorState error={list.error} onRetry={() => list.reload()} />;
  if (list.data.length === 0) return <EmptyState message="No stores." />;
  return (
    <>
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Currency</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {list.data.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td><StatusBadge status={s.status} /></td>
              <td>{s.currency}</td>
              <td>{formatDate(s.createdAt)}</td>
              <td>
                <button className="link-button" onClick={() => onModerate(s)}>
                  {s.status === 'SUSPENDED' ? 'Reinstate' : 'Suspend'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.pagination ? (
        <Pagination pagination={list.pagination} onPage={list.setPage} />
      ) : null}
    </>
  );
}

function ProductTable({
  list,
  onModerate,
}: {
  list: UseApiListResult<AdminProduct, { page?: number; limit?: number }>;
  onModerate: (p: AdminProduct) => void;
}) {
  if (list.loading) return <LoadingState />;
  if (list.error)
    return <ErrorState error={list.error} onRetry={() => list.reload()} />;
  if (list.data.length === 0) return <EmptyState message="No products." />;
  return (
    <>
      <table className="data-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Status</th>
            <th>Price</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {list.data.map((p) => (
            <tr key={p.id}>
              <td>{p.title}</td>
              <td><StatusBadge status={p.status} /></td>
              <td>{formatMoney(p.priceCents, p.currency)}</td>
              <td>{formatDate(p.createdAt)}</td>
              <td>
                <button className="link-button" onClick={() => onModerate(p)}>
                  {p.status === 'REMOVED' ? 'Restore' : 'Remove'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.pagination ? (
        <Pagination pagination={list.pagination} onPage={list.setPage} />
      ) : null}
    </>
  );
}

function OrderTable({
  list,
}: {
  list: UseApiListResult<AdminOrder, { page?: number; limit?: number }>;
}) {
  if (list.loading) return <LoadingState />;
  if (list.error)
    return <ErrorState error={list.error} onRetry={() => list.reload()} />;
  if (list.data.length === 0) return <EmptyState message="No orders." />;
  return (
    <>
      <table className="data-table">
        <thead>
          <tr>
            <th>Order #</th>
            <th>Status</th>
            <th>Total</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {list.data.map((o) => (
            <tr key={o.id}>
              <td>#{o.orderNumber}</td>
              <td><StatusBadge status={o.status} /></td>
              <td>{formatMoney(o.totalCents, o.currency)}</td>
              <td>{formatDate(o.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.pagination ? (
        <Pagination pagination={list.pagination} onPage={list.setPage} />
      ) : null}
    </>
  );
}

function StatusBadge({ status }: { status: StoreStatus | ProductStatus | OrderStatus }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{status}</span>;
}
