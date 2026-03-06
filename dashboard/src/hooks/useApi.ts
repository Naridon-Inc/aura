import { useState, useEffect, useCallback } from 'react';

interface UseApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  options?: { pollInterval?: number; enabled?: boolean }
) {
  const [state, setState] = useState<UseApiState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  const enabled = options?.enabled ?? true;

  const refetch = useCallback(async () => {
    if (!enabled) return;
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const data = await fetcher();
      setState({ data, loading: false, error: null });
    } catch (e) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : 'Unknown error',
      }));
    }
  }, [fetcher, enabled]);

  useEffect(() => {
    refetch();
  }, [...deps, enabled]);

  useEffect(() => {
    if (!options?.pollInterval || !enabled) return;
    const interval = setInterval(refetch, options.pollInterval);
    return () => clearInterval(interval);
  }, [options?.pollInterval, refetch, enabled]);

  return { ...state, refetch };
}

export function useMutation<TParams, TResult>(
  mutator: (params: TParams) => Promise<TResult>
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TResult | null>(null);

  const mutate = useCallback(async (params: TParams) => {
    setLoading(true);
    setError(null);
    try {
      const result = await mutator(params);
      setData(result);
      setLoading(false);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      setError(msg);
      setLoading(false);
      throw e;
    }
  }, [mutator]);

  return { mutate, loading, error, data };
}
