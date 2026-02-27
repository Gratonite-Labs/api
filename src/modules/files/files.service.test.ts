import { describe, expect, it } from 'vitest';
import { buildPublicFileHeaders, getMaxUploadSizeForPurpose, isMimeAllowedForPurpose } from './files.service.js';

describe('files mime policy', () => {
  it('allows supported avatar/image mime types', () => {
    expect(isMimeAllowedForPurpose('avatar', 'image/png')).toBe(true);
    expect(isMimeAllowedForPurpose('avatar', 'image/jpeg')).toBe(true);
    expect(isMimeAllowedForPurpose('avatar', 'image/webp')).toBe(true);
  });

  it('blocks unsupported avatar mime types', () => {
    expect(isMimeAllowedForPurpose('avatar', 'video/mp4')).toBe(false);
    expect(isMimeAllowedForPurpose('avatar', 'application/pdf')).toBe(false);
  });

  it('blocks SVG payloads even when image-like', () => {
    expect(isMimeAllowedForPurpose('upload', 'image/svg+xml')).toBe(false);
    expect(isMimeAllowedForPurpose('avatar', 'image/svg+xml')).toBe(false);
    expect(isMimeAllowedForPurpose('server-icon', 'image/svg+xml')).toBe(false);
  });

  it('keeps general upload support for safe text/image types', () => {
    expect(isMimeAllowedForPurpose('upload', 'text/plain')).toBe(true);
    expect(isMimeAllowedForPurpose('upload', 'image/png')).toBe(true);
  });

  it('builds safe public file headers for browser delivery', () => {
    const headers = buildPublicFileHeaders('image/png', 'avatar "unsafe" name.png');
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['Cache-Control']).toContain('immutable');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Content-Disposition']).toMatch(/^inline; filename=".+"/);
    expect(headers['Content-Disposition']).not.toContain('"unsafe"');
  });

  it('returns purpose-specific upload size limits', () => {
    expect(getMaxUploadSizeForPurpose('emoji')).toBe(256 * 1024);
    expect(getMaxUploadSizeForPurpose('avatar')).toBe(10 * 1024 * 1024);
    expect(getMaxUploadSizeForPurpose('upload')).toBe(25 * 1024 * 1024);
    expect(getMaxUploadSizeForPurpose('unknown-purpose')).toBe(25 * 1024 * 1024);
  });
});
