// Phase 26 — discovery hooks.
//
// useRecommendations: loads the For You feed. States mirror the search
// hook (idle/loading/ready/error) plus a refresh() that bypasses the
// server cache. A generation counter discards stale responses.
//
// useEmergingArtists: loads the emerging-artist spotlight once.
//
// useDiscoveryQuery: submits one natural-language query at a time; the
// caller reads policy.aiProvider to render the AI-fallback notice.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api';
import {
  getEmergingArtists,
  getRecommendations,
  queryDiscovery,
  type RecommendationsQuery,
} from './api';
import type { EmergingArtist, RecommendationsResponse } from './types';

export type DiscoveryState = 'idle' | 'loading' | 'ready' | 'error';

export interface RecommendationsResult {
  state: DiscoveryState;
  response: RecommendationsResponse | null;
  error: unknown;
  /** Re-fetch bypassing the server-side cache. */
  refresh: () => void;
  retry: () => void;
}

export function useRecommendations(
  client: ApiClient,
  query: RecommendationsQuery = {},
): RecommendationsResult {
  const [state, setState] = useState<DiscoveryState>('idle');
  const [response, setResponse] = useState<RecommendationsResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  // Query is stable per mount in practice; stringify for the effect deps.
  const queryKey = JSON.stringify(query);

  const refresh = useCallback(() => setAttempt((a) => a + 1), []);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    const id = (generation.current += 1);
    // attempt === 0 is the initial load; later attempts are refreshes.
    const effectiveQuery: RecommendationsQuery =
      attempt === 0 ? query : { ...query, refresh: true };
    setState('loading');
    setError(null);
    let cancelled = false;
    void getRecommendations(client, effectiveQuery)
      .then((res) => {
        if (cancelled || generation.current !== id) return;
        setResponse(res);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled || generation.current !== id) return;
        setError(err);
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [client, queryKey, attempt]);

  return { state, response, error, refresh, retry };
}

export interface EmergingArtistsResult {
  state: DiscoveryState;
  artists: EmergingArtist[];
  error: unknown;
  retry: () => void;
}

export function useEmergingArtists(client: ApiClient): EmergingArtistsResult {
  const [state, setState] = useState<DiscoveryState>('idle');
  const [artists, setArtists] = useState<EmergingArtist[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setError(null);
    void getEmergingArtists(client)
      .then((res) => {
        if (cancelled) return;
        setArtists(res.artists);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err);
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  return { state, artists, error, retry };
}

export type QuerySubmitState = 'idle' | 'loading' | 'ready' | 'error';

export interface DiscoveryQueryResult {
  state: QuerySubmitState;
  response: RecommendationsResponse | null;
  /** The submitted query text the current state belongs to. */
  submittedQuery: string;
  error: unknown;
  submit: (query: string) => void;
  retry: () => void;
  clear: () => void;
}

export function useDiscoveryQuery(client: ApiClient): DiscoveryQueryResult {
  const [state, setState] = useState<QuerySubmitState>('idle');
  const [response, setResponse] = useState<RecommendationsResponse | null>(null);
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);

  const run = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) return;
      const id = (generation.current += 1);
      setSubmittedQuery(trimmed);
      setState('loading');
      setError(null);
      void queryDiscovery(client, trimmed)
        .then((res) => {
          if (generation.current !== id) return;
          setResponse(res);
          setState('ready');
        })
        .catch((err) => {
          if (generation.current !== id) return;
          setError(err);
          setState('error');
        });
    },
    [client],
  );

  const retry = useCallback(() => {
    if (submittedQuery) run(submittedQuery);
  }, [run, submittedQuery]);

  const clear = useCallback(() => {
    generation.current += 1;
    setState('idle');
    setResponse(null);
    setSubmittedQuery('');
    setError(null);
  }, []);

  return { state, response, submittedQuery, error, submit: run, retry, clear };
}
