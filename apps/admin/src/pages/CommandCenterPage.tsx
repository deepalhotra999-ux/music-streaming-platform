// Admin V2 — Command Center.
//
// The platform operations dashboard. Every number comes from
// GET /v1/admin/command-center and is displayed verbatim; the client never
// invents or recomputes metrics. Sections the caller's role cannot see are
// simply absent from the server response (permission-filtered backend-side).

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getCommandCenter, getTimeline } from '../api/ops';
import type { CommandCenter, TimelineItem } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { formatDate, formatDurationMs, formatMoney, formatNumber } from '../utils/format';
import { NotPermitted } from '../components/PermissionGate';

function StatCard({ value, label }: { value: string; label: string }): React.ReactNode {
  return (
    <div className="stat-card">
      <p className="stat-value">{value}</p>
      <p className="stat-label">{label}</p>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <section aria-label={title}>
      <h2 className="muted" style={{ fontSize: 14 }}>
        {title}
      </h2>
      <div className="stat-grid">{children}</div>
    </section>
  );
}

export function CommandCenterPage(): React.ReactNode {
  const { client } = useAuth();
  const [data, setData] = useState<CommandCenter | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cc, tl] = await Promise.all([getCommandCenter(client), getTimeline(client, 15)]);
      setData(cc);
      setTimeline(tl);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState label="Loading command center…" />;
  if (error) {
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: number }).status
        : undefined;
    if (status === 403) return <NotPermitted error={error} />;
    return <ErrorState error={error} onRetry={() => void load()} />;
  }
  if (!data) return <EmptyState message="No command center data." />;

  return (
    <div>
      <div className="page-header">
        <h1>Command Center</h1>
        <p className="muted" style={{ fontSize: 13 }}>
          Generated {formatDate(data.generatedAt)} · all figures server-computed
        </p>
      </div>

      <Section title="Users">
        <StatCard value={formatNumber(data.users.total)} label="Total users" />
        <StatCard value={formatNumber(data.users.new7d)} label="New (7d)" />
        <StatCard value={formatNumber(data.users.active30d)} label="Active (30d)" />
        <StatCard value={formatNumber(data.users.suspended)} label="Suspended" />
        <StatCard value={formatNumber(data.users.adminCount)} label="Admin accounts" />
      </Section>

      <Section title="Artists">
        <StatCard value={formatNumber(data.artists.total)} label="Total artists" />
        <StatCard value={formatNumber(data.artists.verified)} label="Verified" />
        <StatCard value={formatNumber(data.artists.unverified)} label="Unverified" />
        <StatCard value={formatNumber(data.artists.suspended)} label="Suspended" />
      </Section>

      <Section title="Playback">
        <StatCard value={formatNumber(data.playback.sessions24h)} label="Sessions (24h)" />
        <StatCard value={formatNumber(data.playback.activeSessions)} label="Active sessions" />
        <StatCard value={formatNumber(data.playback.streams7d)} label="Streams (7d)" />
        <StatCard
          value={formatDurationMs(data.playback.listeningTimeMs7d)}
          label="Listening time (7d)"
        />
        <StatCard value={formatNumber(data.playback.uniqueListeners7d)} label="Listeners (7d)" />
        <StatCard value={formatNumber(data.playback.errors24h)} label="Errors (24h)" />
      </Section>

      <Section title="Catalog">
        <StatCard value={formatNumber(data.catalog.tracks)} label="Tracks" />
        <StatCard value={formatNumber(data.catalog.tracksReady)} label="Ready" />
        <StatCard value={formatNumber(data.catalog.tracksProcessing)} label="Processing" />
        <StatCard value={formatNumber(data.catalog.tracksFailed)} label="Failed" />
        <StatCard value={formatNumber(data.catalog.tracksTakedown)} label="Takedown" />
        <StatCard value={formatNumber(data.catalog.albums)} label="Albums" />
      </Section>

      <Section title="Subscriptions">
        <StatCard value={formatNumber(data.subscriptions.total)} label="Total" />
        <StatCard value={formatNumber(data.subscriptions.entitledNow)} label="Entitled now" />
        {Object.entries(data.subscriptions.byStatus).map(([status, count]) => (
          <StatCard key={status} value={formatNumber(count)} label={status} />
        ))}
      </Section>

      <Section title="Finance">
        <StatCard
          value={formatMoney(
            data.finance.commerceRevenueCents,
            data.finance.royaltyCurrency ?? 'USD',
          )}
          label="Commerce revenue"
        />
        <StatCard
          value={formatMoney(
            data.finance.commerceRefundsCents,
            data.finance.royaltyCurrency ?? 'USD',
          )}
          label="Commerce refunds"
        />
        <StatCard
          value={`${data.finance.royaltyAllocated} ${data.finance.royaltyCurrency ?? ''}`}
          label="Royalties allocated"
        />
        <StatCard value={formatNumber(data.finance.chargebacks)} label="Chargebacks" />
      </Section>

      <Section title="Commerce">
        <StatCard value={formatNumber(data.commerce.orders)} label="Orders" />
        <StatCard value={formatNumber(data.commerce.stores)} label="Stores" />
        <StatCard value={formatNumber(data.commerce.products)} label="Products" />
        {Object.entries(data.commerce.ordersByStatus).map(([status, count]) => (
          <StatCard key={status} value={formatNumber(count)} label={`Orders: ${status}`} />
        ))}
      </Section>

      <Section title="Community">
        <StatCard value={formatNumber(data.community.posts)} label="Posts" />
        <StatCard value={formatNumber(data.community.comments)} label="Comments" />
        <StatCard value={formatNumber(data.community.openReports)} label="Open reports" />
      </Section>

      <Section title="Ingestion & webhooks">
        <StatCard value={formatNumber(data.ingestion.processing)} label="Ingestion processing" />
        <StatCard value={formatNumber(data.ingestion.failed)} label="Ingestion failed" />
        <StatCard value={formatNumber(data.ingestion.succeededJobs)} label="Jobs succeeded" />
        <StatCard value={formatNumber(data.ingestion.failedJobs)} label="Jobs failed" />
        <StatCard value={formatNumber(data.webhooks.subscription.received)} label="Sub webhooks" />
        <StatCard value={formatNumber(data.webhooks.commerce.received)} label="Commerce webhooks" />
      </Section>

      <Section title="System">
        <StatCard value={data.system.maintenanceMode ? 'ON' : 'off'} label="Maintenance mode" />
        <StatCard value={data.system.readonlyMode ? 'ON' : 'off'} label="Read-only mode" />
        <StatCard value={formatNumber(data.system.requestsTotal)} label="Requests total" />
        <StatCard value={formatNumber(data.system.requests5xx)} label="5xx responses" />
        <StatCard value={formatNumber(data.system.authFailures)} label="Auth failures" />
        <StatCard value={formatNumber(data.system.rateLimitHits)} label="Rate-limit hits" />
        <StatCard value={formatNumber(data.system.dbErrors)} label="DB errors" />
        <StatCard value={formatNumber(data.system.wsCurrent)} label="WS connections" />
      </Section>

      <section aria-label="Platform timeline">
        <h2 className="muted" style={{ fontSize: 14 }}>
          Platform timeline
        </h2>
        {!timeline || timeline.length === 0 ? (
          <EmptyState message="No recent platform events." />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Event</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((item, index) => (
                  <tr key={`${item.at}-${index}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(item.at)}</td>
                    <td>
                      <span className="badge badge-gray">{item.kind}</span>
                    </td>
                    <td>{item.title}</td>
                    <td className="muted">{item.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-label="Quick links">
        <h2 className="muted" style={{ fontSize: 14 }}>
          Quick links
        </h2>
        <div className="toolbar">
          <Link className="btn" to="/users">
            Users
          </Link>
          <Link className="btn" to="/moderation">
            Moderation
          </Link>
          <Link className="btn" to="/finance">
            Finance
          </Link>
          <Link className="btn" to="/security">
            Security
          </Link>
          <Link className="btn" to="/audit">
            Audit log
          </Link>
        </div>
      </section>
    </div>
  );
}
