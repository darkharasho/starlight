import { describe, it, expect } from 'vitest';
import { PermissionError, AttachError } from '../src/errors.js';

describe('error hierarchy', () => {
  it('PermissionError extends AttachError-related EngineError', () => {
    const e = new PermissionError('boom');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('PermissionError');
  });

  it('AttachError preserves cause', () => {
    const cause = new Error('underlying');
    const e = new AttachError('failed', cause);
    expect(e.cause).toBe(cause);
  });
});
