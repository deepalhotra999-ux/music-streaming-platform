// Phase 16 — artist management: search, verified filter, paginated table,
// detail view, and verify/unverify behind explicit confirmation.

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiErrorMessage } from '../api/client';
import { getArtist, listArtists, setArtistVerified } from '../api/artists';
import type { ArtistDetail } from '../api/types';
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setArtist(await getArtist(client, id));
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
      </div>
      {dialog}
    </div>
  );
}
