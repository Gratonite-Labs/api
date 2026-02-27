import { AsyncLocalStorage } from 'node:async_hooks';

type CacheMetric = {
  hits: number;
  misses: number;
};

type RequestMetrics = {
  cache: Record<string, CacheMetric>;
};

const requestMetricsStorage = new AsyncLocalStorage<RequestMetrics>();

export function runWithRequestMetrics<T>(fn: () => T): T {
  return requestMetricsStorage.run({ cache: {} }, fn);
}

export function recordRequestCacheResult(cache: string, hit: boolean): void {
  const store = requestMetricsStorage.getStore();
  if (!store) return;

  if (!store.cache[cache]) {
    store.cache[cache] = { hits: 0, misses: 0 };
  }

  if (hit) {
    store.cache[cache].hits += 1;
  } else {
    store.cache[cache].misses += 1;
  }
}

export function getRequestCacheSummary() {
  const store = requestMetricsStorage.getStore();
  if (!store) return undefined;

  return store.cache;
}
