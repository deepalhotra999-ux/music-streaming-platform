// Phase 16 — Dashboard: platform totals and server-computed overview.
//
// Totals come from `limit=1` list queries (the backend PageInfo.total is
// authoritative); the overview comes from GET /v1/analytics/platform/overview
// and is displayed verbatim — this page never computes analytics itself.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { listUsers } from '../api/users';
import { listArtists } from '../api/artists';
import { listAlbums, listTracks } from '../api/catalog';
import { getPlatformOverview } from '../api/analytics';
import type { AnalyticsRange, PlatformOverview } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { formatDurationMs, formatNumber } from '../utils/format';

const RANGES: AnalyticsRange[] = ['7d', '28d', '90d', 'all'];

interface Totals {
  users: number;
  artists: number;
  albums: number;
  tracks: number;
  ready: number;
  processing: number;
  failed: number;
  takedown: number;
}

async function fetchTotals(client: Parameters<typeof listUsers>[0]): Promise<Totals> {
  const [users, artists, albums, tracks, ready, processing, failed, takedown] = await Promise.all([
    listUsers(client, { limit: 1 }),
    listArtists(client, { limit: 1 }),
    listAlbums(client, { limit: 1 }),
    listTracks(client, { limit: 1 }),
    listTracks(client, { limit: 1, status: 'READY' }),
    listTracks(client, { limit: 1, status: 'PROCESSING' }),
    listTracks(client, { limit: 1, status: 'FAILED' }),
    listTracks(client, { limit: 1, status: 'TAKEDOWN' }),
  ]);
  return {
    users: users.pagination.total,
    artists: artists.pagination.total,
    albums: albums.pagination.total,
    tracks: tracks.pagination.total,
    ready: ready.pagination.total,
    processing: processing.pagination.total,
    failed: failed.pagination.total,
    takedown: takedown.pagination.total,
  };
}

export function DashboardPage(): React.ReactNode {
  const { client } = useAuth();
  const [totals, setTotals] = useState<Totals | null>(null);
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [range, setRange] = useState<AnalyticsRange>('7d');
  const [loadingTotals, setLoadingTotals] = useState(true);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [totalsError, setTotalsError] = useState<unknown>(null);
  const [overviewError, setOverviewError] = useState<unknown>(null);
  const overviewRequest = useRef(0);

  const loadTotals = useCallback(async () => {
    setLoadingTotals(true);
    setTotalsError(null);
    try {
      setTotals(await fetchTotals(client));
    } catch (err) {
      setTotalsError(err);
    } finally {
      setLoadingTotals(false);
    }
  }, [client]);

  const loadOverview = useCallback(
    async (r: AnalyticsRange) => {
      const id = ++overviewRequest.current;
      setLoadingOverview(true);
      setOverviewError(null);
      try {
        const result = await getPlatformOverview(client, r);
        if (overviewRequest.current === id) setOverview(result);
      } catch (err) {
        if (overviewRequest.current === id) setOverviewError(err);
      } finally {
        if (overviewRequest.current === id) setLoadingOverview(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void loadTotals();
  }, [loadTotals]);

  useEffect(() => {
    void loadOverview(range);
  }, [loadOverview, range]);

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
      </div>

      <section aria-label="Catalog totals">
        <h2 className="muted" style={{ fontSize: 14 }}>
          Catalog totals
        </h2>
        {loadingTotals ? (
          <LoadingState label="Loading totals…" />
        ) : totalsError ? (
          <ErrorState error={totalsError} onRetry={() => void loadTotals()} />
        ) : totals ? (
          <div className="stat-grid">
            <div className="stat-card">
              <p className="stat-value">{formatNumber(totals.users)}</p>
              <p className="stat-label">Users</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{formatNumber(totals.artists)}</p>
              <p className="stat-label">Artists</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{formatNumber(totals.albums)}</p>
              <p className="stat-label">Albums</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{formatNumber(totals.tracks)}</p>
              <p className="stat-label">Tracks</p>
            </div>
          </div>
        ) : null}
      </section>

      <section aria-label="Track status breakdown">
        <h2 className="muted" style={{ fontSize: 14 }}>
          Track status
        </h2>
        {loadingTotals ? (
          <LoadingState label="Loading track status…" />
        ) : totalsError ? (
          <ErrorState error={totalsError} onRetry={() => void loadTotals()} />
        ) : totals ? (
          <div className="stat-grid">
            <div className="stat-card">
              <p className="stat-value">{formatNumber(totals.ready)}</p>
              <p className="stat-label">Ready (published)</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{formatNumber(totals.processing)}</p>
              <p className="stat-label">Processing (unpublished)</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{formatNumber(totals.failed)}</p>
              <p className="stat-label">Failed (unpublished)</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{formatNumber(totals.takedown)}</p>
              <p className="stat-label">Takedown</p>
            </div>
          </div>
        ) : null}
      </section>

      <section aria-label="Platform overview">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <h2 className="muted" style={{ fontSize: 14, margin: 0 }}>
            Platform overview
          </h2>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="dashboard-range" className="mono">
              Range
            </label>
            <select
              id="dashboard-range"
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
        {loadingOverview ? (
          <LoadingState label="Loading platform overview…" />
        ) : overviewError ? (
          <ErrorState error={overviewError} onRetry={() => void loadOverview(range)} />
        ) : overview ? (
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
          </div>
        ) : (
          <EmptyState message="No platform overview data for this range." />
        )}
        {overview && !loadingOverview && !overviewError && (
          <p className="muted" style={{ fontSize: 13 }}>
            Failed plays: {formatNumber(overview.failedPlays)} · Incomplete plays:{' '}
            {formatNumber(overview.incompletePlays)}
            {overview.outcomes && Object.keys(overview.outcomes).length > 0 && (
              <>
                {' '}
                · Outcomes:{' '}
                {Object.entries(overview.outcomes)
                  .map(([key, value]) => `${key}=${formatNumber(value)}`)
                  .join(', ')}
              </>
            )}
          </p>
        )}
      </section>
    </div>
  );
}
