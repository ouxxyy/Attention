import { describe, it, expect } from 'vitest';
import { validateConfig, validateRating, validateRatingsFile } from '../schema';
import { defaultConfig } from '../defaults';

describe('config schema', () => {
  it('accepts valid default config', () => {
    const result = validateConfig(defaultConfig);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('rejects empty object', () => {
    const result = validateConfig({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects null', () => {
    const result = validateConfig(null);
    expect(result.valid).toBe(false);
  });

  it('rejects missing thresholds', () => {
    const { thresholds, ...rest } = defaultConfig;
    const result = validateConfig(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('thresholds'))).toBe(true);
  });

  it('rejects invalid threshold value (flowMinMinutes = 0)', () => {
    const config = { ...defaultConfig, thresholds: { ...defaultConfig.thresholds, flowMinMinutes: 0 } };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
  });

  it('rejects non-array mainTaskKeywords', () => {
    const config = { ...defaultConfig, mainTaskKeywords: 'not-array' };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
  });

  it('rejects missing patterns in keyword rule', () => {
    const config = {
      ...defaultConfig,
      mainTaskKeywords: [{ label: 'test', match: 'substring', priority: 50 }]
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
  });

  it('accepts sharedKeywords when they are strings', () => {
    const config = { ...defaultConfig, sharedKeywords: ['New Tab', 'GitHub'] };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  it('rejects non-string sharedKeywords entries', () => {
    const config = { ...defaultConfig, sharedKeywords: ['New Tab', 123] };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
  });

  it('rejects invalid notifications.enabled type', () => {
    const config = { ...defaultConfig, notifications: { ...defaultConfig.notifications, enabled: 'yes' } };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
  });
});

describe('rating schema', () => {
  it('accepts valid rating entry', () => {
    const result = validateRating({ score: 4, note: '上午状态好', updatedAt: '2026-05-31T10:00:00+08:00' });
    expect(result.valid).toBe(true);
  });

  it('accepts rating without note', () => {
    const result = validateRating({ score: 3, updatedAt: '2026-05-31T10:00:00Z' });
    expect(result.valid).toBe(true);
  });

  it('rejects score 6 (out of 1-5 range)', () => {
    const result = validateRating({ score: 6, note: '', updatedAt: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('1-5') || e.includes('score'))).toBe(true);
  });

  it('rejects score 0 (out of range)', () => {
    const result = validateRating({ score: 0, note: '', updatedAt: '' });
    expect(result.valid).toBe(false);
  });

  it('rejects non-integer score', () => {
    const result = validateRating({ score: 2.5, note: '', updatedAt: '' });
    expect(result.valid).toBe(false);
  });

  it('rejects note longer than 500 chars', () => {
    const result = validateRating({ score: 3, note: 'x'.repeat(501), updatedAt: '' });
    expect(result.valid).toBe(false);
  });

  it('rejects null input', () => {
    const result = validateRating(null);
    expect(result.valid).toBe(false);
  });
});

describe('ratings file schema', () => {
  it('accepts valid ratings file', () => {
    const result = validateRatingsFile({
      ratings: {
        '2026-05-31': { score: 4, note: '不错的一天', updatedAt: '2026-05-31T10:00:00+08:00' }
      }
    });
    expect(result.valid).toBe(true);
  });

  it('rejects invalid date key format', () => {
    const result = validateRatingsFile({
      ratings: {
        'not-a-date': { score: 3, note: '', updatedAt: '' }
      }
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('日期'))).toBe(true);
  });

  it('rejects malformed date key (31-05-2026)', () => {
    const result = validateRatingsFile({
      ratings: {
        '31-05-2026': { score: 3, note: '', updatedAt: '' }
      }
    });
    expect(result.valid).toBe(false);
  });

  it('rejects nested rating with score 6 in file', () => {
    const result = validateRatingsFile({
      ratings: {
        '2026-05-31': { score: 6, note: '', updatedAt: '' }
      }
    });
    expect(result.valid).toBe(false);
  });
});
