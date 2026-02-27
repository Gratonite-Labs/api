function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!url.protocol.startsWith('http')) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function isPrivateIpv4(hostname: string): boolean {
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  const match = hostname.match(/^172\.(\d{1,3})\./);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 16 && second <= 31;
}

function isSafeDevHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    isPrivateIpv4(hostname)
  );
}

export function parseAllowedOrigins(rawValue: string): { allowAny: boolean; origins: Set<string> } {
  const entries = rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const allowAny = entries.includes('*');
  const origins = new Set<string>();

  for (const entry of entries) {
    if (entry === '*') continue;
    const normalized = normalizeOrigin(entry);
    if (normalized) origins.add(normalized);
  }

  return { allowAny, origins };
}

export function isOriginAllowed(
  origin: string | undefined,
  nodeEnv: 'development' | 'production' | 'test',
  allowed: { allowAny: boolean; origins: Set<string> },
): boolean {
  if (!origin) return true;
  if (allowed.allowAny) return true;

  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (allowed.origins.has(normalized)) return true;

  if (nodeEnv === 'development') {
    try {
      const hostname = new URL(normalized).hostname;
      return isSafeDevHost(hostname);
    } catch {
      return false;
    }
  }

  return false;
}

