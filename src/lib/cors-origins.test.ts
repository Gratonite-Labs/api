import { describe, expect, it } from 'vitest';
import { isOriginAllowed, parseAllowedOrigins } from './cors-origins.js';

describe('cors origin helper', () => {
  it('allows explicit configured origins', () => {
    const allowed = parseAllowedOrigins('http://localhost:5173,https://app.example.com');
    expect(isOriginAllowed('http://localhost:5173', 'production', allowed)).toBe(true);
    expect(isOriginAllowed('https://app.example.com', 'production', allowed)).toBe(true);
  });

  it('rejects unknown origins in production', () => {
    const allowed = parseAllowedOrigins('http://localhost:5173');
    expect(isOriginAllowed('http://192.168.1.10:5173', 'production', allowed)).toBe(false);
  });

  it('allows localhost and private LAN origins in development', () => {
    const allowed = parseAllowedOrigins('http://localhost:5173');
    expect(isOriginAllowed('http://localhost:4173', 'development', allowed)).toBe(true);
    expect(isOriginAllowed('http://192.168.1.10:5173', 'development', allowed)).toBe(true);
    expect(isOriginAllowed('http://10.0.0.8:5173', 'development', allowed)).toBe(true);
  });

  it('blocks non-local unknown hosts in development', () => {
    const allowed = parseAllowedOrigins('http://localhost:5173');
    expect(isOriginAllowed('https://evil.example.com', 'development', allowed)).toBe(false);
  });

  it('supports wildcard allow-all when explicitly configured', () => {
    const allowed = parseAllowedOrigins('*');
    expect(isOriginAllowed('https://any.example.com', 'production', allowed)).toBe(true);
  });

  it('rejects malformed origins when wildcard is not configured', () => {
    const allowed = parseAllowedOrigins('https://app.example.com');
    expect(isOriginAllowed('chrome-extension://abc', 'production', allowed)).toBe(false);
    expect(isOriginAllowed('not-a-url', 'production', allowed)).toBe(false);
  });

  it('normalizes and deduplicates configured origins', () => {
    const allowed = parseAllowedOrigins('https://app.example.com/, https://app.example.com');
    expect(isOriginAllowed('https://app.example.com', 'production', allowed)).toBe(true);
  });
});
