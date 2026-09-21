// Phase 16 — catalog: artists, albums, and tracks in one tabbed view.
//
// Supported admin actions only: the existing PATCH/DELETE endpoints (verify
// lives on the Artists page; deletes are offered here), each behind an
// explicit ConfirmDialog. No new publishing workflows, no bulk operations.

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiErrorMessage } from '../api/client';
import {
  deleteAlbum,
  deleteTrack,
  getAlbum,
  getTrack,
  listAlbums,
  listTracks,
  updateTrackStatus,
} from '../api/catalog';
import { listArtists } from '../api/artists';
import type {
  AlbumDetail,
  AlbumListItem,
  TrackDetail,
  TrackListItem,
  TrackStatus,
} from '../api/types';
import type { AlbumListQuery, TrackListQuery } from '../api/catalog';
import { useApiList } from '../hooks/useApiList';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { Pagination } from '../components/Pagination';
import { StatusBadge } from '../components/Badges';
import { useConfirm } from '../components/ConfirmDialog';
import { formatDate, formatDateOnly, formatNumber } from '../utils/format';

type CatalogTab = 'artists' | 'albums' | 'tracks';
const PAGE_SIZE = 20;
const TRACK_STATUSES: (TrackStatus | '')[] = ['', 'READY', 'PROCESSING', 'FAILED', 'TAKEDOWN'];

export function CatalogPage(): React.ReactNode {
  const [tab, setTab] = useState<CatalogTab>('tracks');

  return (
    <div>
      <div className="page-header">
        <h1>Catalog</h1>
      </div>
      <div className="tabs" role="tablist" aria-label="Catalog sections">
        {(
          [
            { id: 'artists', label: 'Artists' },
            { id: 'albums', label: 'Albums' },
            { id: 'tracks', label: 'Tracks' },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'tab active' : 'tab'}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === 'artists' && <CatalogArtistsTab />}
      {tab === 'albums' && <CatalogAlbumsTab />}
      {tab === 'tracks' && <CatalogTracksTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Artists tab (read + delete; verification lives on the Artists page)
// ---------------------------------------------------------------------------

function CatalogArtistsTab(): React.ReactNode {
  return (
    <div>
      <p className="muted">
        Artist management (search, detail, verification) lives on the{' '}
        <a href="#/artists">Artists page</a>. This tab is a read-only catalog overview.
      </p>
      <ArtistOverviewList />
    </div>
  );
}

function ArtistOverviewList(): React.ReactNode {
  const { client } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const fetcher = useCallback(
    (query: { q?: string; page?: number }) =>
      listArtists(client, { q: query.q, page: query.page, limit: PAGE_SIZE }),
    [client],
  );
  const list = useApiList(fetcher, { page: 1 } as { q?: string; page?: number });

  function handleSearch(event: FormEvent): void {
    event.preventDefault();
    list.setQuery({ q: searchInput.trim() || undefined });
  }

  return (
    <div>
      <form className="toolbar" onSubmit={handleSearch}>
        <div className="field search-input">
          <label htmlFor="catalog-artist-search">Search</label>
          <input
            id="catalog-artist-search"
            type="search"
            placeholder="Artist name…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <button type="submit" className="btn">
          Search
        </button>
      </form>
      {list.loading ? (
        <LoadingState label="Loading artists…" />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data.length === 0 ? (
        <EmptyState message="No artists found." />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Verified</th>
                  <th>Followers</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((artist) => (
                  <tr key={artist.id}>
                    <td>{artist.name}</td>
                    <td>{artist.verified ? 'Yes' : 'No'}</td>
                    <td>{formatNumber(artist.followerCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.pagination && <Pagination pagination={list.pagination} onPage={list.setPage} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Albums tab
// ---------------------------------------------------------------------------

function CatalogAlbumsTab(): React.ReactNode {
  const { client } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [searchInput, setSearchInput] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetcher = useCallback(
    (query: AlbumListQuery) => listAlbums(client, { ...query, limit: PAGE_SIZE }),
    [client],
  );
  const list = useApiList(fetcher, { page: 1 } as AlbumListQuery);

  function handleSearch(event: FormEvent): void {
    event.preventDefault();
    list.setQuery({ q: searchInput.trim() || undefined });
  }

  async function handleDelete(album: AlbumListItem): Promise<void> {
    setActionError(null);
    const confirmed = await confirm({
      title: 'Delete album?',
      message: `"${album.title}" by ${album.artistName} (${album.trackCount} tracks) will be permanently removed from the catalog. This cannot be undone.`,
      confirmLabel: 'Delete album',
    });
    if (!confirmed) return;
    try {
      await deleteAlbum(client, album.id);
      if (selectedId === album.id) setSelectedId(null);
      list.reload();
    } catch (err) {
      setActionError(apiErrorMessage(err));
    }
  }

  return (
    <div>
      {selectedId ? (
        <AlbumDetailView
          id={selectedId}
          onBack={() => setSelectedId(null)}
          onDelete={handleDelete}
        />
      ) : (
        <>
          <form className="toolbar" onSubmit={handleSearch}>
            <div className="field search-input">
              <label htmlFor="catalog-album-search">Search</label>
              <input
                id="catalog-album-search"
                type="search"
                placeholder="Album title…"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
              />
            </div>
            <button type="submit" className="btn">
              Search
            </button>
          </form>
          {actionError && (
            <div className="form-error" role="alert">
              {actionError}
            </div>
          )}
          {list.loading ? (
            <LoadingState label="Loading albums…" />
          ) : list.error ? (
            <ErrorState error={list.error} onRetry={list.reload} />
          ) : list.data.length === 0 ? (
            <EmptyState message="No albums found." />
          ) : (
            <>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Artist</th>
                      <th>Type</th>
                      <th>Released</th>
                      <th>Tracks</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.map((album) => (
                      <tr key={album.id}>
                        <td>{album.title}</td>
                        <td>{album.artistName}</td>
                        <td>{album.albumType}</td>
                        <td>{formatDateOnly(album.releaseDate)}</td>
                        <td>{formatNumber(album.trackCount)}</td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => setSelectedId(album.id)}
                            >
                              View
                            </button>
                            <button
                              type="button"
                              className="link-button"
                              style={{ color: '#ff9a9d' }}
                              onClick={() => void handleDelete(album)}
                            >
                              Delete
                            </button>
                          </div>
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
      {dialog}
    </div>
  );
}

function AlbumDetailView({
  id,
  onBack,
  onDelete,
}: {
  id: string;
  onBack: () => void;
  onDelete: (album: AlbumListItem) => Promise<void>;
}): React.ReactNode {
  const { client } = useAuth();
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAlbum(await getAlbum(client, id));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState label="Loading album…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!album) return <EmptyState message="Album not found." />;

  return (
    <div>
      <button type="button" className="link-button back-link" onClick={onBack}>
        ← Back to albums
      </button>
      <div className="card">
        <h2>{album.title}</h2>
        <div className="detail-grid">
          <div className="detail-item">
            <p className="detail-label">Artist</p>
            <p className="detail-value">{album.artistName}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Type</p>
            <p className="detail-value">{album.albumType}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Released</p>
            <p className="detail-value">{formatDateOnly(album.releaseDate)}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Album ID</p>
            <p className="detail-value mono">{album.id}</p>
          </div>
        </div>
        <div className="toolbar" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-outline-danger"
            onClick={() => void onDelete(album)}
          >
            Delete album
          </button>
        </div>
      </div>
      <div className="card">
        <h2>Tracks ({album.tracks.length})</h2>
        {album.tracks.length === 0 ? (
          <EmptyState message="This album has no tracks." />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Title</th>
                  <th>Duration</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {album.tracks.map((track) => (
                  <tr key={track.id}>
                    <td>{track.trackNumber ?? '—'}</td>
                    <td>{track.title}</td>
                    <td>{formatDuration(track.durationMs)}</td>
                    <td>
                      <StatusBadge status={track.status as TrackStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tracks tab
// ---------------------------------------------------------------------------

function CatalogTracksTab(): React.ReactNode {
  const { client } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [searchInput, setSearchInput] = useState('');
  const [statusInput, setStatusInput] = useState<TrackStatus | ''>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetcher = useCallback(
    (query: TrackListQuery) => listTracks(client, { ...query, limit: PAGE_SIZE }),
    [client],
  );
  const list = useApiList(fetcher, { page: 1 } as TrackListQuery);

  function handleSearch(event: FormEvent): void {
    event.preventDefault();
    list.setQuery({
      q: searchInput.trim() || undefined,
      status: statusInput || undefined,
    });
  }

  function clearFilters(): void {
    setSearchInput('');
    setStatusInput('');
    list.setQuery({ q: undefined, status: undefined });
  }

  async function handleDelete(track: TrackListItem): Promise<void> {
    setActionError(null);
    const confirmed = await confirm({
      title: 'Delete track?',
      message: `"${track.title}" by ${track.artistName} will be permanently removed from the catalog. This cannot be undone.`,
      confirmLabel: 'Delete track',
    });
    if (!confirmed) return;
    try {
      await deleteTrack(client, track.id);
      if (selectedId === track.id) setSelectedId(null);
      list.reload();
    } catch (err) {
      setActionError(apiErrorMessage(err));
    }
  }

  return (
    <div>
      {selectedId ? (
        <TrackDetailView
          id={selectedId}
          onBack={() => setSelectedId(null)}
          onDelete={handleDelete}
        />
      ) : (
        <>
          <form className="toolbar" onSubmit={handleSearch}>
            <div className="field search-input">
              <label htmlFor="catalog-track-search">Search</label>
              <input
                id="catalog-track-search"
                type="search"
                placeholder="Track title…"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="catalog-track-status">Status</label>
              <select
                id="catalog-track-status"
                value={statusInput}
                onChange={(event) => setStatusInput(event.target.value as TrackStatus | '')}
              >
                {TRACK_STATUSES.map((status) => (
                  <option key={status || 'all'} value={status}>
                    {status || 'All statuses'}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn">
              Search
            </button>
            <button type="button" className="btn" onClick={clearFilters}>
              Clear
            </button>
          </form>
          {actionError && (
            <div className="form-error" role="alert">
              {actionError}
            </div>
          )}
          {list.loading ? (
            <LoadingState label="Loading tracks…" />
          ) : list.error ? (
            <ErrorState error={list.error} onRetry={list.reload} />
          ) : list.data.length === 0 ? (
            <EmptyState message="No tracks match the current filters." />
          ) : (
            <>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Artist</th>
                      <th>Album</th>
                      <th>Status</th>
                      <th>Plays</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.map((track) => (
                      <tr key={track.id}>
                        <td>{track.title}</td>
                        <td>{track.artistName}</td>
                        <td>{track.albumTitle ?? '—'}</td>
                        <td>
                          <StatusBadge status={track.status} />
                        </td>
                        <td>{formatNumber(track.playCount)}</td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => setSelectedId(track.id)}
                            >
                              View
                            </button>
                            <button
                              type="button"
                              className="link-button"
                              style={{ color: '#ff9a9d' }}
                              onClick={() => void handleDelete(track)}
                            >
                              Delete
                            </button>
                          </div>
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
      {dialog}
    </div>
  );
}

function TrackDetailView({
  id,
  onBack,
  onDelete,
}: {
  id: string;
  onBack: () => void;
  onDelete: (track: TrackListItem) => Promise<void>;
}): React.ReactNode {
  const { client } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [track, setTrack] = useState<TrackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTrack(await getTrack(client, id));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleTakedown(): Promise<void> {
    if (!track) return;
    setActionError(null);
    const confirmed = await confirm({
      title: 'Take down this track?',
      message: `“${track.title}” will be removed from the public catalog immediately (status → TAKEDOWN). The track is not deleted. This action is recorded in the audit log.`,
      confirmLabel: 'Take down',
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      setTrack(await updateTrackStatus(client, track.id, 'TAKEDOWN'));
    } catch (err) {
      setActionError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleRestore(): Promise<void> {
    if (!track) return;
    setActionError(null);
    const confirmed = await confirm({
      title: 'Restore this track?',
      message: `“${track.title}” will return to PROCESSING and become eligible for re-ingestion (only the audio pipeline may mark a track READY). This action is recorded in the audit log.`,
      confirmLabel: 'Restore',
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      setTrack(await updateTrackStatus(client, track.id, 'PROCESSING'));
    } catch (err) {
      setActionError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading track…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!track) return <EmptyState message="Track not found." />;

  return (
    <div>
      <button type="button" className="link-button back-link" onClick={onBack}>
        ← Back to tracks
      </button>
      {actionError && (
        <div className="form-error" role="alert">
          {actionError}
        </div>
      )}
      <div className="card">
        <h2>{track.title}</h2>
        <div className="detail-grid">
          <div className="detail-item">
            <p className="detail-label">Status</p>
            <p className="detail-value">
              <StatusBadge status={track.status} />
            </p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Artist</p>
            <p className="detail-value">{track.artistName}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Album</p>
            <p className="detail-value">{track.albumTitle ?? '—'}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Duration</p>
            <p className="detail-value">{formatDuration(track.durationMs)}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">ISRC</p>
            <p className="detail-value mono">{track.isrc ?? '—'}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Genres</p>
            <p className="detail-value">
              {track.genres.length > 0 ? track.genres.map((g) => g.name).join(', ') : '—'}
            </p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Audio ingest</p>
            <p className="detail-value">{track.audioStatus}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Plays</p>
            <p className="detail-value">{formatNumber(track.playCount)}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Track ID</p>
            <p className="detail-value mono">{track.id}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Created</p>
            <p className="detail-value">{formatDate(track.createdAt)}</p>
          </div>
        </div>
        <div className="toolbar" style={{ marginTop: 16 }}>
          {track.status === 'TAKEDOWN' ? (
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void handleRestore()}>
              {saving ? 'Restoring…' : 'Restore track'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-outline-danger"
              disabled={saving}
              onClick={() => void handleTakedown()}
            >
              {saving ? 'Taking down…' : 'Take down'}
            </button>
          )}
          <button
            type="button"
            className="btn btn-outline-danger"
            onClick={() => void onDelete(track)}
          >
            Delete track
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          Takedown hides the track from the public catalog without deleting it. Delete is a
          soft delete (the track is hidden and recoverable). Both actions are recorded in the
          audit log.
        </p>
      </div>
      {dialog}
    </div>
  );
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}
