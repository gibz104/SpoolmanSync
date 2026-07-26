/**
 * Classify whether a thrown fetch error is a network-level failure (host
 * unreachable, connection refused, DNS failure) as opposed to a protocol or
 * application error.
 *
 * Node's fetch (undici) wraps the OS-level error: the thrown TypeError has a
 * `cause` whose `code` carries the real reason. Walking the cause chain lets us
 * tell the user "your container cannot reach Home Assistant" instead of a
 * generic "OAuth authentication failed" (issue #74 — a Docker networking
 * problem surfaced as an auth error, sending the user down entirely the wrong
 * debugging path).
 */
const NETWORK_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

export function isNetworkError(err: unknown): boolean {
  let current: unknown = err;
  // Bounded walk — cause chains are short, but never risk a cycle.
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object') {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
      // AbortSignal.timeout() rejections surface as TimeoutError DOMExceptions.
      const name = (current as { name?: unknown }).name;
      if (name === 'TimeoutError') return true;
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

/**
 * True when the error is a timeout (e.g. an AbortSignal.timeout() rejection)
 * rather than an affirmative can't-connect failure.
 *
 * The distinction matters for pre-flight checks: connection-refused or DNS
 * failure proves the host is unreachable, but a timeout can just mean the host
 * is slow (HA mid-startup, a Pi under recorder load). Treating a timeout as
 * proof of unreachability blocked setups that worked fine before.
 */
export function isTimeoutError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object') {
      if ((current as { name?: unknown }).name === 'TimeoutError') return true;
      if ((current as { code?: unknown }).code === 'ETIMEDOUT') return true;
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}
