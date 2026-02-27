type RouteAlertConfig = {
  id: string;
  method: string;
  pathPattern: RegExp;
  p95ThresholdMs: number;
  minSamples: number;
};

type AlertPayload = {
  id: string;
  method: string;
  path: string;
  p95Ms: number;
  thresholdMs: number;
  sampleCount: number;
  statusCode: number;
};

type RouteWindowState = {
  samples: number[];
  alerted: boolean;
};

type RouteState = {
  [routeId: string]: RouteWindowState;
};

type CreateLatencyAlertsInput = {
  routes: RouteAlertConfig[];
  windowMs?: number;
  onAlert: (payload: AlertPayload) => void;
};

function percentile95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx] ?? 0;
}

export function createLatencyAlerts({
  routes,
  windowMs = 60_000,
  onAlert,
}: CreateLatencyAlertsInput) {
  let windowStart = Date.now();
  let routeState: RouteState = {};

  function resetWindow(now: number) {
    windowStart = now;
    routeState = {};
  }

  function observe(input: {
    method: string;
    path: string;
    durationMs: number;
    statusCode: number;
  }) {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      resetWindow(now);
    }

    for (const route of routes) {
      if (route.method !== input.method) continue;
      if (!route.pathPattern.test(input.path)) continue;

      const current = routeState[route.id] ?? { samples: [], alerted: false };
      current.samples.push(input.durationMs);
      routeState[route.id] = current;

      if (current.alerted) continue;
      if (current.samples.length < route.minSamples) continue;

      const p95 = percentile95(current.samples);
      if (p95 < route.p95ThresholdMs) continue;

      current.alerted = true;
      onAlert({
        id: route.id,
        method: route.method,
        path: input.path,
        p95Ms: Math.round(p95),
        thresholdMs: route.p95ThresholdMs,
        sampleCount: current.samples.length,
        statusCode: input.statusCode,
      });
    }
  }

  return { observe };
}

