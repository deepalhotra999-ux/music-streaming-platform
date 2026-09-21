// Phase 16 — artist management: search, verified filter, paginated table,
// detail view, and verify/unverify behind explicit confirmation.
// Phase 17 — detail view adds verification history (from the audit log) and
// a 28-day analytics summary (server-computed, displayed verbatim).

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiErrorMessage } from '../api/client';
import { getArtist, listArtists, setArtistVerified } from '../api/artists';
import { getArtistOverview } from '../api/analytics';
import { listAuditLogs } from '../api/audit';
import type { ArtistDetail, AuditLog, PlatformOverview } from '../api/types';
import type { ArtistListQuery } from '../api/artists';
import { useApiList } from '../hooks/useApiList';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { Pagination } from '../components/Pagination';
import { VerifiedBadge } from '../components/Badges';
import { useConfirm } from '../components/ConfirmDialog';
import { formatDate, formatNumber } from '../utils/format';

type VerifiedFilter = '' | 'true' | 'false';
const PAGE_SIZE = 20;

export function ArtistsPage(): React.ReactNode {
  const { client } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const [verifiedInput, setVerifiedInput] = useState<VerifiedFilter>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetcher = useCallback(
    (query: ArtistListQuery) => listArtists(client, { ...query, limit: PAGE_SIZE }),
    [client],
  );
  const list = useApiList(fetcher, { page: 1 } as ArtistListQuery);

  function handleSearch(event: FormEvent): void {
    event.preventDefault();
    list.setQuery({
      q: searchInput.trim() || undefined,
      verified: verifiedInput === '' ? undefined : verifiedInput === 'true',
    });
  }

  function clearFilters(): void {
    setSearchInput('');
    setVerifiedInput('');
    list.setQuery({ q: undefined, verified: undefined });
  }

  return (
    <div>
      <div className="page-header">
        <h1>Artists</h1>
      </div>

      {selectedId ? (
        <ArtistDetailView
          id={selectedId}
          onBack={() => setSelectedId(null)}
          onChanged={list.reload}
        />
      ) : (
        <>
          <form className="toolbar" onSubmit={handleSearch}>
            <div className="field search-input">
              <label htmlFor="artists-search">Search</label>
              <input
                id="artists-search"
                type="search"
                placeholder="Artist name…"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="artists-verified">Verified</label>
              <select
                id="artists-verified"
                value={verifiedInput}
                onChange={(event) => setVerifiedInput(event.target.value as VerifiedFilter)}
              >
                <option value="">All</option>
                <option value="true">Verified</option>
                <option value="false">Unverified</option>
              </select>
            </div>
            <button type="submit" className="btn">
              Search
            </button>
            <button type="button" className="btn" onClick={clearFilters}>
              Clear
            </button>
          </form>

          {list.loading ? (
            <LoadingState label="Loading artists…" />
          ) : list.error ? (
            <ErrorState error={list.error} onRetry={list.reload} />
          ) : list.data.length === 0 ? (
            <EmptyState message="No artists match the current filters." />
          ) : (
            <>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Verified</th>
                      <th>Followers</th>
                      <th>Created</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.map((artist) => (
                      <tr key={artist.id}>
                        <td>{artist.name}</td>
                        <td>
                          <VerifiedBadge verified={artist.verified} />
                        </td>
                        <td>{formatNumber(artist.followerCount)}</td>
                        <td>{formatDate(artist.createdAt)}</td>
                        <td>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => setSelectedId(artist.id)}
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {list.pagination && <Pagination pagination={list.pagination} onPage={list.setPage} />}
            </>
          )}
        </>
      )}
    </div>
  );
}

function ArtistDetailView({
  id,
  onBack,
  onChanged,
}: {
  id: string;
  onBack: () => void;
  onChanged: () => void;
}): React.ReactNode {
  const { client } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [artist, setArtist] = useState<ArtistDetail | null>(null);
  const [verificationHistory, setVerificationHistory] = useState<AuditLog[]>([]);
  const [analytics, setAnalytics] = useState<PlatformOverview | null>(null);
  const [analyticsError, setAnalyticsError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAnalyticsError(false);
    try {
      const [fetched, history, overview] = await Promise.all([
        getArtist(client, id),
        listAuditLogs(client, { targetType: 'artist', targetId: id, limit: 50 }).catch(
          () => ({ data: [] as AuditLog[], pagination: null }) as never,
        ),
        getArtistOverview(client, id, '28d').catch(() => null),
      ]);
      setArtist(fetched);
      setVerificationHistory(
        (history.data as AuditLog[]).filter((e) =>
          ['artist.verified', 'artist.unverified'].includes(e.action),
        ),
      );
      if (overview) {
        setAnalytics(overview);
      } else {
        setAnalyticsError(true);
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleVerifyToggle(): Promise<void> {
    if (!artist) return;
    const next = !artist.verified;
    setActionError(null);
    const confirmed = await confirm({
      title: next ? 'Verify artist?' : 'Remove verification?',
      message: next
        ? `${artist.name} will be marked as verified. Verified artists get a public badge on their profile.`
        : `${artist.name} will no longer be marked as verified. The public badge will be removed.`,
      confirmLabel: next ? 'Verify artist' : 'Remove verification',
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      const updated = await setArtistVerified(client, artist.id, next);
      setArtist(updated);
      onChanged();
    } catch (err) {
      setActionError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading artist…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!artist) return <EmptyState message="Artist not found." />;

  return (
    <div>
      <button type="button" className="link-button back-link" onClick={onBack}>
        ← Back to artists
      </button>
      {actionError && (
        <div className="form-error" role="alert">
          {actionError}
        </div>
      )}
      <div className="card">
        <h2>
          {artist.name} <VerifiedBadge verified={artist.verified} />
        </h2>
        <div className="detail-grid">
          <div className="detail-item">
            <p className="detail-label">Artist ID</p>
            <p className="detail-value mono">{artist.id}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Albums</p>
            <p className="detail-value">{formatNumber(artist.counts.albums)}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Tracks</p>
            <p className="detail-value">{formatNumber(artist.counts.tracks)}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Followers</p>
            <p className="detail-value">{formatNumber(artist.counts.followers)}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Bio</p>
            <p className="detail-value">{artist.profile?.bio || '—'}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Website</p>
            <p className="detail-value">{artist.profile?.website || '—'}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Created</p>
            <p className="detail-value">{formatDate(artist.createdAt)}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Updated</p>
            <p className="detail-value">{formatDate(artist.updatedAt)}</p>
          </div>
        </div>
      </div>
      <div className="card">
        <h2>Verification</h2>
        <div className="toolbar">
          <button
            type="button"
            className={artist.verified ? 'btn btn-outline-danger' : 'btn btn-primary'}
            style={artist.verified ? undefined : { width: 'auto' }}
            disabled={saving}
            onClick={() => void handleVerifyToggle()}
          >
            {saving ? 'Saving…' : artist.verified ? 'Remove verification' : 'Verify artist'}
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          Verification changes are recorded in the audit log.
        </p>
        {verificationHistory.length > 0 && (
          <>
            <h3 style={{ fontSize: 14, marginTop: 16 }}>Verification history</h3>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {verificationHistory.map((entry) => (
                    <tr key={entry.id}>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {entry.action}
                      </td>
                      <td>{formatDate(entry.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <div className="card">
        <h2>Analytics — last 28 days</h2>
        {analyticsError || !analytics ? (
          <p className="muted" style={{ fontSize: 13 }}>
            Analytics unavailable for this artist.
          </p>
        ) : (
          <div className="detail-grid">
            <div className="detail-item">
              <p className="detail-label">Streams</p>
              <p className="detail-value">{formatNumber(analytics.streams)}</p>
            </div>
            <div className="detail-item">
              <p className="detail-label">Starts</p>
              <p className="detail-value">{formatNumber(analytics.starts)}</p>
            </div>
            <div className="detail-item">
              <p className="detail-label">Unique listeners</p>
              <p className="detail-value">{formatNumber(analytics.uniqueListeners)}</p>
            </div>
            <div className="detail-item">
              <p className="detail-label">Listening time</p>
              <p className="detail-value">
                {formatNumber(Math.round(analytics.listeningTimeMs / 60000))} min
              </p>
            </div>
          </div>
        )}
        <p className="muted" style={{ fontSize: 13 }}>
          Server-computed from the play events stream. A stream is a session with a completed
          play.
        </p>
      </div>
      {dialog}
    </div>
  );
}
