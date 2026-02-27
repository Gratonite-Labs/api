import { describe, expect, it, vi } from 'vitest';
import { createLatencyAlerts } from './latency-alerts.js';

describe('latency alerts', () => {
  it('emits once when p95 breaches threshold after enough samples', () => {
    const onAlert = vi.fn();
    const alerts = createLatencyAlerts({
      routes: [
        {
          id: 'message_send',
          method: 'POST',
          pathPattern: /^\/api\/v1\/channels\/[^/]+\/messages$/,
          p95ThresholdMs: 500,
          minSamples: 3,
        },
      ],
      onAlert,
    });

    alerts.observe({ method: 'POST', path: '/api/v1/channels/1/messages', durationMs: 300, statusCode: 201 });
    alerts.observe({ method: 'POST', path: '/api/v1/channels/1/messages', durationMs: 450, statusCode: 201 });
    expect(onAlert).toHaveBeenCalledTimes(0);

    alerts.observe({ method: 'POST', path: '/api/v1/channels/1/messages', durationMs: 900, statusCode: 201 });
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]?.[0]).toMatchObject({
      id: 'message_send',
      thresholdMs: 500,
      sampleCount: 3,
    });

    alerts.observe({ method: 'POST', path: '/api/v1/channels/1/messages', durationMs: 800, statusCode: 201 });
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('does not emit for non-matching routes or methods', () => {
    const onAlert = vi.fn();
    const alerts = createLatencyAlerts({
      routes: [
        {
          id: 'upload',
          method: 'POST',
          pathPattern: /^\/api\/v1\/files\/upload$/,
          p95ThresholdMs: 2000,
          minSamples: 2,
        },
      ],
      onAlert,
    });

    alerts.observe({ method: 'GET', path: '/api/v1/files/upload', durationMs: 3000, statusCode: 200 });
    alerts.observe({ method: 'POST', path: '/api/v1/other', durationMs: 3000, statusCode: 200 });
    expect(onAlert).toHaveBeenCalledTimes(0);
  });
});

