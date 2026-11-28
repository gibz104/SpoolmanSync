/**
 * Utilities for handling Home Assistant ingress path
 *
 * When running as an HA add-on, the app is accessed through HA's ingress proxy.
 * HA ingress strips the base path before forwarding requests, so internal
 * navigation works with relative URLs. However, external links (QR codes,
 * NFC tags) need special handling since ingress URLs require HA authentication.
 *
 * IMPORTANT: QR codes and NFC tags generated in add-on mode will only work
 * when scanned by a device that is:
 * 1. On the same network as Home Assistant, OR
 * 2. Has access to Home Assistant's external URL
 *
 * Users may need to expose the add-on port directly for external QR access.
 */

/**
 * Get the ingress path from the cookie (client-side only)
 * Returns empty string if not in ingress mode
 */
export function getIngressPath(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  const match = document.cookie.match(/ha-ingress-path=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * The ingress base path from the X-Ingress-Path header Home Assistant sends
 * with each request through ingress (e.g., "/api/hassio_ingress/abc123"), for
 * redirects the server sends. Returns '' outside ingress, and for a value
 * that doesn't look like an ingress path, so a redirect stays a path on the
 * address the browser used and never points at another site.
 */
export function ingressPathFromHeader(header: string | null): string {
  if (!header || !/^(\/[\w-]+)+\/?$/.test(header)) return '';
  return header.replace(/\/$/, '');
}

/**
 * Check if running in HA ingress mode
 */
export function isIngressMode(): boolean {
  return !!getIngressPath();
}

/**
 * Build a full URL for the current page, suitable for QR codes and NFC tags.
 *
 * In addon/ingress mode, we can't use ingress URLs for direct browser access
 * because HA ingress strips the base path, causing CSS/JS assets to fail loading
 * (the browser requests /_next/static/... from HA instead of through ingress).
 *
 * Instead, we point to the Next.js server directly on the configured direct
 * access port (default 3000), which is accessible on the local network via
 * host_network: true. This gives a clean URL with no path prefix issues.
 *
 * In non-ingress mode, returns the standard origin + path.
 *
 * @param path - The path to build the URL for
 * @param directAccessPort - The direct access port (addon mode only, default 3000)
 * @param qrBaseUrl - Optional user-configured base URL override for QR codes/NFC tags
 */
export function buildExternalUrl(path: string, directAccessPort: number = 3000, qrBaseUrl?: string): string {
  if (typeof window === 'undefined') {
    return path;
  }

  // Ensure path starts with /
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  // User-configured override takes priority (e.g., for reverse proxy setups)
  if (qrBaseUrl) {
    return `${qrBaseUrl}${normalizedPath}`;
  }

  if (isIngressMode()) {
    // In addon mode, use the Next.js server directly on the configured port
    // host_network: true makes this accessible from the local network
    return `http://${window.location.hostname}:${directAccessPort}${normalizedPath}`;
  }

  return `${window.location.origin}${normalizedPath}`;
}
