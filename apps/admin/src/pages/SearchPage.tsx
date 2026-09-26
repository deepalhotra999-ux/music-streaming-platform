// Admin V2 — global search.
//
// Debounced query against GET /v1/admin/search. Result types are filtered
// server-side by the caller's permissions; `excludedTypes` tells the UI
// which types were withheld. User/artist hits navigate to their detail
// views; everything else is informational.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { globalSearch } from '../api/ops';
import type { GlobalSearchResult, SearchResultType } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { NotPermitted } from '../components/PermissionGate';

const TYPE_LABEL: Record<SearchResultType, string> = {
  user: 'Users',
  artist: 'Artists',
  album: 'Albums',
  track: 'Tracks',
  playlist: 'Playlists',
  order: 'Orders',
  store: 'Stores',
  post: 'Posts',
  report: 'Reports',
  audit: 'Audit entries',
};

export function SearchPage(): React.ReactNode {
  const { client } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<GlobalSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = ++requestId.current;
    const timer = window.setTimeout(() => {
      globalSearch(client, trimmed)
        .then((res) => {
          if (requestId.current === id) {
            setResult(res);
            setError(null);
          }
        })
        .catch((err) => {
          if (requestId.current === id) setError(err);
        })
        .finally(() => {
          if (requestId.current === id) setLoading(false);
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [client, query]);

  function openResult(type: SearchResultType, id: string): void {
    if (type === 'user') navigate('/users', { state: { userId: id } });
    else if (type === 'artist') navigate('/artists', { state: { artistId: id } });
  }

  const grouped = new Map<SearchResultType, GlobalSearchResult['results']>();
  for (const item of result?.results ?? []) {
    const list = grouped.get(item.type) ?? [];
    list.push(item);
    grouped.set(item.type, list);
  }

  return (
    <div>
      <div className="page-header">
        <h1>Search</h1>
      </div>
      <div className="toolbar">
        <div className="field search-input">
          <label htmlFor="global-search">Search everything</label>
          <input
            id="global-search"
            type="search"
            placeholder="Users, artists, tracks, orders… (min 2 chars)"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
          />
        </div>
      </div>

      {query.trim().length >= 2 && loading && <LoadingState label="Searching…" />}
      {error ? (
        (() => {
          const status =
            typeof error === 'object' && error !== null && 'status' in error
              ? (error as { status?: number }).status
              : undefined;
          return status === 403 ? (
            <NotPermitted error={error} />
          ) : (
            <ErrorState error={error} onRetry={() => setQuery((q) => `${q} `)} />
          );
        })()
      ) : result ? (
        result.results.length === 0 ? (
          <EmptyState message="No results." />
        ) : (
          <>
            {result.excludedTypes.length > 0 && (
              <p className="muted" style={{ fontSize: 13 }}>
                Withheld by your permissions: {result.excludedTypes.join(', ')}
              </p>
            )}
            {Array.from(grouped.entries()).map(([type, items]) => (
              <section key={type} aria-label={TYPE_LABEL[type]}>
                <h2 className="muted" style={{ fontSize: 14 }}>
                  {TYPE_LABEL[type]} ({items.length})
                </h2>
                <div className="table-wrap">
                  <table className="data-table">
                    <tbody>
                      {items.map((item) => {
                        const clickable = type === 'user' || type === 'artist';
                        return (
                          <tr key={`${type}-${item.id}`}>
                            <td>
                              {clickable ? (
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() => openResult(type, item.id)}
                                >
                                  {item.title}
                                </button>
                              ) : (
                                item.title
                              )}
                            </td>
                            <td className="muted">{item.subtitle}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </>
        )
      ) : (
        <EmptyState message="Type at least 2 characters to search across users, catalog, orders, and more." />
      )}
    </div>
  );
}
