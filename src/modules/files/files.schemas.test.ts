import { describe, expect, it } from 'vitest';
import { uploadFileSchema } from './files.schemas.js';

describe('upload file schema', () => {
  it('parses valid metadata payloads', () => {
    const parsed = uploadFileSchema.parse({
      purpose: 'upload',
      description: ' short description ',
      spoiler: 'true',
      isVoiceMessage: 'true',
      durationSecs: '12',
      waveform: 'abc123+/=',
    });
    expect(parsed.description).toBe('short description');
    expect(parsed.spoiler).toBe(true);
    expect(parsed.isVoiceMessage).toBe(true);
    expect(parsed.durationSecs).toBe(12);
    expect(parsed.waveform).toBe('abc123+/=');
  });

  it('rejects oversize description and waveform', () => {
    const tooLongDescription = 'a'.repeat(1025);
    const tooLongWaveform = 'b'.repeat(4097);
    expect(() =>
      uploadFileSchema.parse({
        description: tooLongDescription,
      }),
    ).toThrow();
    expect(() =>
      uploadFileSchema.parse({
        waveform: tooLongWaveform,
      }),
    ).toThrow();
  });

  it('sanitizes control characters and drops empty descriptions', () => {
    const sanitized = uploadFileSchema.parse({
      description: '\u0007 hello\u0000',
      isVoiceMessage: true,
      durationSecs: 5,
      waveform: 'abcd',
    });
    expect(sanitized.description).toBe('hello');

    const empty = uploadFileSchema.parse({
      description: '   ',
      isVoiceMessage: true,
      durationSecs: 5,
      waveform: 'abcd',
    });
    expect(empty.description).toBeUndefined();
  });

  it('rejects out-of-range voice duration', () => {
    expect(() =>
      uploadFileSchema.parse({ isVoiceMessage: true, durationSecs: -1, waveform: 'abcd' }),
    ).toThrow();
    expect(() =>
      uploadFileSchema.parse({ isVoiceMessage: true, durationSecs: 601, waveform: 'abcd' }),
    ).toThrow();
    expect(
      uploadFileSchema.parse({ isVoiceMessage: true, durationSecs: 600, waveform: 'abcd' }).durationSecs,
    ).toBe(600);
  });

  it('enforces voice metadata consistency', () => {
    expect(() => uploadFileSchema.parse({ isVoiceMessage: true, durationSecs: 5 })).toThrow();
    expect(() => uploadFileSchema.parse({ isVoiceMessage: true, waveform: 'abcd' })).toThrow();
    expect(() => uploadFileSchema.parse({ isVoiceMessage: false, durationSecs: 5 })).toThrow();
    expect(() => uploadFileSchema.parse({ isVoiceMessage: false, waveform: 'abcd' })).toThrow();
  });

  it('rejects invalid waveform characters', () => {
    expect(() =>
      uploadFileSchema.parse({
        isVoiceMessage: true,
        durationSecs: 4,
        waveform: 'not valid !!!',
      }),
    ).toThrow();
  });
});
