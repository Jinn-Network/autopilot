import { describe, it, expect } from 'vitest';
import { DEFAULT_FLOOR } from '../../src/dispatcher/rate-limit-guard.js';

describe('DEFAULT_FLOOR', () => {
  it('is 500 — comfortable headroom for an in-flight session mid-gh-call', () => {
    expect(DEFAULT_FLOOR).toBe(500);
  });
});
