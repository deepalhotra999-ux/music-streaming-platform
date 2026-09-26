// Phase 16 — platform analytics display.
//
// Every number on this page is server-computed (GET
// /v1/analytics/platform/overview over the play_events stream) and is shown
// VERBATIM. This page contains no aggregation, no averaging, and no derived
// metrics of its own — it only picks a range and renders what the server
// returned.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { getPlatformOverview } from '../api/analytics';
import type { AnalyticsRange, PlatformOverview } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { formatDateOnly, formatDurationMs, formatNumber } from '../utils/format';

const RANGES: AnalyticsRange[] = ['7d', '28d', '90d', 'all'];

export function AnalyticsPage(): React.ReactNode {
  const { client } = useAuth();
  const [range, setRange] = useState<AnalyticsRange>('7d');
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const requestId = useRef(0);

  const load = useCallback(
    async (r: AnalyticsRange) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const result = await getPlatformOverview(client, r);
        if (requestId.current === id) setOverview(result);
      } catch (err) {
        if (requestId.current === id) setError(err);
      } finally {
        if (requestId.current === id) setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void load(range);
  }, [load, range]);

  return (
    <div>
      <div className="page-header">
        <h1>Analytics</h1>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="analytics-range">Range</label>
          <select
            id="analytics-range"
            value={range}
            onChange={(event) => setRange(event.target.value as AnalyticsRange)}
          >
            {RANGES.map((r) => (
              <option key={r} value={r}>
                {r === 'all' ? 'All time' : `Last ${r}`}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <LoadingState label="Loading platform analytics…" />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void load(range)} />
      ) : overview ? (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            Server-computed for range <strong>{overview.range}</strong>
            {overview.from && (
              <>
                {' '}
                · from {formatDateOnly(overview.from)} to {formatDateOnly(overview.to)}
              </>
            )}
            . Shown exactly as reported by the API.
          </p>
          <div className="stat-grid">
            <div className="stat-card">
              <p className="stat-value">{formatNumber(overview.streams)}</p>
              <p className="stat-label">Streams (completed sessions)</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{formatNumber(overview.starts)}</p>
              <p className="stat-label">Playback starts</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{formatNumber(overview.uniqueListeners)}</p>
              <p className="stat-label">Unique listeners</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{formatDurationMs(overview.listeningTimeMs)}</p>
              <p className="stat-label">Listening time</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{formatNumber(overview.failedPlays)}</p>
              <p className="stat-label">Failed plays</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{formatNumber(overview.incompletePlays)}</p>
              <p className="stat-label">Incomplete plays</p>
            </div>
          </div>
          {overview.outcomes && Object.keys(overview.outcomes).length > 0 && (
            <div className="card">
              <h2>Outcome breakdown</h2>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Outcome</th>
                      <th scope="col">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(overview.outcomes).map(([outcome, count]) => (
                      <tr key={outcome}>
                        <td>{outcome}</td>
                        <td>{formatNumber(count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : (
        <EmptyState message="No analytics data for this range." />
      )}
    </div>
  );
}
