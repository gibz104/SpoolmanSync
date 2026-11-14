/**
 * Checks for URLs and URL parts that come from a user or a request.
 *
 * SpoolmanSync has no login, so a request can come from anyone who can reach
 * it. Anything from a request that ends up in a Home Assistant or Spoolman URL
 * goes through here first, so it can only ever reach the endpoint it was meant
 * for, with SpoolmanSync's login attached.
 */

/**
 * "http://ha:8123///" -> "http://ha:8123". A loop rather than /\/+$/, which
 * takes quadratic time on a long run of slashes.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

/**
 * A Home Assistant, Spoolman or QR code base URL as typed: trimmed and without
 * trailing slashes, or null unless it is an http:// or https:// URL.
 */
export function parseServiceUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = trimTrailingSlashes(input.trim());
  if (!trimmed || trimmed.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
  return trimmed;
}

const SEGMENT = /^[\w.-]{1,128}$/;

/**
 * Whether a value can be one segment of an API path, such as a config flow ID
 * or an entity ID: letters, digits, '_', '-' and '.', but not '.' or '..'.
 * Nothing in it can lead to another endpoint.
 */
export function isPathSegment(value: unknown): value is string {
  return typeof value === 'string' && SEGMENT.test(value) && value !== '.' && value !== '..';
}

/** The value as one API path segment, or an error naming what was wrong. */
export function pathSegment(value: unknown, what: string): string {
  if (!isPathSegment(value)) throw new Error(`Invalid ${what}`);
  return value;
}

/** A numeric ID for an API path, such as a spool's, or an error. */
export function positiveId(value: unknown, what: string): number {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid ${what}`);
  return id;
}
