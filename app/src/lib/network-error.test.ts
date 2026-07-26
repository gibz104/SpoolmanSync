import { describe, it, expect } from 'vitest';
import { isNetworkError, isTimeoutError } from './network-error';

/**
 * Classification behind the ha_unreachable error (issue #74): a container that
 * cannot reach Home Assistant must be reported as a networking problem, not as
 * "OAuth authentication failed".
 */
describe('isNetworkError', () => {
  const withCause = (code: string) => {
    // Shape thrown by Node's fetch (undici): TypeError with a cause carrying
    // the OS-level error code.
    const cause = Object.assign(new Error('connect failed'), { code });
    return Object.assign(new TypeError('fetch failed'), { cause });
  };

  it.each([
    'UND_ERR_CONNECT_TIMEOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'ECONNRESET',
    'EAI_AGAIN',
  ])('classifies a fetch error with cause code %s as network', (code) => {
    expect(isNetworkError(withCause(code))).toBe(true);
  });

  it('classifies a bare error carrying the code directly', () => {
    expect(isNetworkError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
  });

  it('walks nested cause chains', () => {
    const inner = Object.assign(new Error('inner'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    const mid = Object.assign(new Error('mid'), { cause: inner });
    const outer = Object.assign(new TypeError('fetch failed'), { cause: mid });
    expect(isNetworkError(outer)).toBe(true);
  });

  it('classifies AbortSignal.timeout rejections (TimeoutError) as network', () => {
    const err = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    expect(isNetworkError(err)).toBe(true);
  });

  it('does NOT classify application errors as network', () => {
    expect(isNetworkError(new Error('invalid_grant'))).toBe(false);
    expect(isNetworkError(new SyntaxError('Unexpected token'))).toBe(false);
    expect(isNetworkError(Object.assign(new Error('x'), { code: 'SOME_OTHER_CODE' }))).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError('string error')).toBe(false);
  });

  it('survives a cyclic cause chain', () => {
    const a: Record<string, unknown> = { message: 'a' };
    const b: Record<string, unknown> = { message: 'b', cause: a };
    a.cause = b;
    expect(isNetworkError(a)).toBe(false);
  });

  it('does NOT classify TLS trust errors as network (the host WAS reached)', () => {
    for (const code of [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ]) {
      expect(isNetworkError(withCause(code)), code).toBe(false);
    }
  });
});

describe('isTimeoutError', () => {
  it('classifies AbortSignal.timeout rejections', () => {
    const err = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    expect(isTimeoutError(err)).toBe(true);
  });

  it('classifies ETIMEDOUT, including nested', () => {
    const inner = Object.assign(new Error('t'), { code: 'ETIMEDOUT' });
    expect(isTimeoutError(inner)).toBe(true);
    expect(isTimeoutError(Object.assign(new TypeError('fetch failed'), { cause: inner }))).toBe(true);
  });

  it('does NOT classify affirmative connection failures as timeouts', () => {
    // These prove unreachability and must remain blockable in pre-flight
    // checks; only genuine timeouts are advisory.
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']) {
      const inner = Object.assign(new Error('x'), { code });
      const err = Object.assign(new TypeError('fetch failed'), { cause: inner });
      expect(isTimeoutError(err), code).toBe(false);
    }
    expect(isTimeoutError(new Error('plain'))).toBe(false);
  });
});
