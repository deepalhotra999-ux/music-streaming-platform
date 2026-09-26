// Admin V2 — Operations: system health, background jobs, webhooks, and
// the platform timeline. Everything here is visibility-only — the backend
// exposes no job execution or retry endpoints.

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { getJobsOverview, getSystemHealth, getTimeline, getWebhooksOverview } from '../api/ops';
import type { JobsOverview, SystemHealth, TimelineItem, WebhooksOverview } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { RequirePermission } from '../components/PermissionGate';
import { formatDate, formatDurationMs } from '../utils/format';

export function OpsPage(): React.ReactNode {
  return (
    <RequirePermission anyOf={['jobs.view', 'webhooks.view', 'system.view']}>
      <OpsContent />
    </RequirePermission>
  );
}

function OpsContent(): React.ReactNode {
  const { client } = useAuth();
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [jobs, setJobs] = useState<JobsOverview | null>(null);
  const [webhooks, setWebhooks] = useState<WebhooksOverview | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [h, j, w, t] = await Promise.all([
        getSystemHealth(client),
        getJobsOverview(client),
        getWebhooksOverview(client),
        getTimeline(client, 25),
      ]);
      setHealth(h);
      setJobs(j);
      setWebhooks(w);
      setTimeline(t);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState label="Loading operations…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;

  return (
    <div>
      <div className="page-header">
        <h1>Operations</h1>
      </div>

      <div className="card">
        <h2>System health</h2>
        {!health ? (
          <EmptyState message="No health data." />
        ) : (
          <>
            <dl className="kv-list">
              <dt>API</dt>
              <dd>
                <span className="badge badge-green">ok</span>{' '}
                <span className="muted">
                  uptime {formatDurationMs(health.api.uptimeSeconds * 1000)}
                </span>
              </dd>
              <dt>Database</dt>
              <dd>
                {health.database.status === 'ok' ? (
                  <span className="badge badge-green">ok</span>
                ) : (
                  <span className="badge badge-red">error</span>
                )}{' '}
                <span className="muted">
                  {health.database.latencyMs !== null ? `${health.database.latencyMs} ms` : ''}
                  {health.database.error ? ` — ${health.database.error}` : ''}
                </span>
              </dd>
              <dt>Storage</dt>
              <dd>
                <span className="mono">{health.storage.driver}</span>{' '}
                <span className="muted">{health.storage.status}</span>
              </dd>
              <dt>Emergency</dt>
              <dd>
                {health.emergency.maintenanceMode && (
                  <span className="badge badge-red">Maintenance</span>
                )}{' '}
                {health.emergency.readonlyMode && (
                  <span className="badge badge-yellow">Read-only</span>
                )}{' '}
                {!health.emergency.newSignupsEnabled && (
                  <span className="badge badge-yellow">Signups disabled</span>
                )}
                {!health.emergency.maintenanceMode &&
                  !health.emergency.readonlyMode &&
                  health.emergency.newSignupsEnabled && <span className="muted">Normal</span>}
              </dd>
              <dt>Requests</dt>
              <dd className="mono">
                {health.metrics.requestsTotal} total · {health.metrics.requests5xx} 5xx ·{' '}
                {health.metrics.dbErrors} DB errors
              </dd>
            </dl>
            <p className="muted" style={{ fontSize: 12 }}>
              Generated {formatDate(health.generatedAt)}
            </p>
          </>
        )}
      </div>

      <div className="card">
        <h2>Background jobs</h2>
        {!jobs ? (
          <EmptyState message="No job data." />
        ) : (
          <>
            <p className="muted" style={{ fontSize: 13 }}>
              {jobs.note}
            </p>
            <div className="detail-grid">
              <div className="detail-item">
                <p className="detail-label">Ingestion queued</p>
                <p className="detail-value">{jobs.ingestion.queued}</p>
              </div>
              <div className="detail-item">
                <p className="detail-label">Ingestion processing</p>
                <p className="detail-value">{jobs.ingestion.processing}</p>
              </div>
              <div className="detail-item">
                <p className="detail-label">Ingestion failed</p>
                <p className="detail-value">{jobs.ingestion.failed}</p>
              </div>
              <div className="detail-item">
                <p className="detail-label">Ingestion ready</p>
                <p className="detail-value">{jobs.ingestion.ready}</p>
              </div>
              <div className="detail-item">
                <p className="detail-label">Royalty runs succeeded</p>
                <p className="detail-value">{jobs.royaltyRuns.succeeded}</p>
              </div>
              <div className="detail-item">
                <p className="detail-label">Royalty runs failed</p>
                <p className="detail-value">{jobs.royaltyRuns.failed}</p>
              </div>
            </div>
            {jobs.ingestion.recentFailed.length > 0 && (
              <>
                <h3>Recent failed ingestion</h3>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Track</th>
                        <th scope="col">Artist</th>
                        <th scope="col">Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.ingestion.recentFailed.map((track) => (
                        <tr key={track.id}>
                          <td>{track.title}</td>
                          <td>{track.artistName ?? '—'}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{formatDate(track.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>Webhooks</h2>
        {!webhooks ? (
          <EmptyState message="No webhook data." />
        ) : (
          <>
            <p className="muted" style={{ fontSize: 13 }}>
              {webhooks.note}
            </p>
            <div className="detail-grid">
              <div className="detail-item">
                <p className="detail-label">Received</p>
                <p className="detail-value">{webhooks.subscription.received}</p>
              </div>
              <div className="detail-item">
                <p className="detail-label">Duplicates</p>
                <p className="detail-value">{webhooks.subscription.duplicates}</p>
              </div>
              <div className="detail-item">
                <p className="detail-label">Failed</p>
                <p className="detail-value">{webhooks.subscription.failed}</p>
              </div>
            </div>
            {webhooks.subscription.recent.length > 0 && (
              <>
                <h3>Recent webhook events</h3>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Time</th>
                        <th scope="col">Provider</th>
                        <th scope="col">Event</th>
                        <th scope="col">Transition</th>
                      </tr>
                    </thead>
                    <tbody>
                      {webhooks.subscription.recent.map((event) => (
                        <tr key={event.id}>
                          <td style={{ whiteSpace: 'nowrap' }}>{formatDate(event.createdAt)}</td>
                          <td>{event.provider}</td>
                          <td className="mono">{event.eventType}</td>
                          <td className="mono">
                            {event.statusFrom ?? '—'} → {event.statusTo ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>Platform timeline</h2>
        {!timeline || timeline.length === 0 ? (
          <EmptyState message="Nothing in the timeline yet." />
        ) : (
          <ul className="timeline">
            {timeline.map((item, index) => (
              <li key={`${item.at}-${index}`} className="timeline-item">
                <div className="timeline-time">{formatDate(item.at)}</div>
                <div>
                  <strong>{item.title}</strong>{' '}
                  <span className="badge badge-gray">{item.kind}</span>
                  {item.detail && <p className="muted">{item.detail}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
