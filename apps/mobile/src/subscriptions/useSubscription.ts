// Phase 18 — subscription state hook.
// Loads the server-computed subscription + entitlement for the signed-in
// user. States: idle → loading → ready | error, with retry. The hook only
// displays what the server reports; it never decides entitlement itself.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage, getMySubscription, type ApiClient, type MySubscription } from '../api';

export type SubscriptionLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface UseSubscriptionResult {
  state: SubscriptionLoadState;
  data: MySubscription | null;
  error: string | null;
  retry: () => void;
}

export function useSubscription(api: ApiClient | null): UseSubscriptionResult {
  const [state, setState] = useState<SubscriptionLoadState>('idle');
  const [data, setData] = useState<MySubscription | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!api) {
      setState('idle');
      setData(null);
      setError(null);
      return;
    }
    setState('loading');
    setError(null);
    try {
      const result = await getMySubscription(api);
      if (!mounted.current) return;
      setData(result);
      setState('ready');
    } catch (err) {
      if (!mounted.current) return;
      setError(apiErrorMessage(err));
      setState('error');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return { state, data, error, retry: load };
}
