/**
 * Webhook shared-secret helper.
 *
 * The HA-facing webhook (`/api/webhook`) is reachable on the LAN (it must be, so
 * phones and HA can POST to it). To prevent arbitrary clients from corrupting
 * inventory, generated HA automations include an `X-SpoolmanSync-Token` header
 * carrying this secret, and the webhook rejects requests that don't match.
 *
 * Backward-compatibility: if no secret has been generated yet (e.g. an existing
 * install that has not regenerated its automations), `getWebhookSecret()` returns
 * null and the webhook stays open. The secret is created when automations are
 * (re)generated, at which point enforcement begins.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import prisma from '@/lib/db';

export const WEBHOOK_SECRET_KEY = 'webhook_secret';
export const WEBHOOK_AUTH_ENABLED_KEY = 'webhook_auth_enabled';
export const WEBHOOK_TOKEN_HEADER = 'x-spoolmansync-token';

/** Return the stored webhook secret, or null if one has not been generated yet. */
export async function getWebhookSecret(): Promise<string | null> {
  const setting = await prisma.settings.findUnique({ where: { key: WEBHOOK_SECRET_KEY } });
  return setting?.value || null;
}

/**
 * Whether the webhook should ENFORCE the secret. This is deliberately separate
 * from "a secret exists": the secret is created when automations are *generated*
 * (so the produced YAML carries the token), but enforcement must only begin once
 * those token-carrying automations have actually been *applied* — otherwise a
 * user who merely previews automations would have their still-deployed (tokenless)
 * automations rejected, silently stopping all filament deductions.
 */
export async function isWebhookAuthEnabled(): Promise<boolean> {
  const setting = await prisma.settings.findUnique({ where: { key: WEBHOOK_AUTH_ENABLED_KEY } });
  return setting?.value === 'true';
}

/** Turn on webhook enforcement. Call this only once the generated automations are applied. */
export async function enableWebhookAuth(): Promise<void> {
  await prisma.settings.upsert({
    where: { key: WEBHOOK_AUTH_ENABLED_KEY },
    create: { key: WEBHOOK_AUTH_ENABLED_KEY, value: 'true' },
    update: { value: 'true' },
  });
}

/**
 * Return the existing webhook secret, generating and persisting one if absent.
 *
 * Two callers arriving together (previewing and applying automations) must get
 * the same secret, so a stored one is never replaced and the value returned is
 * the one the database holds; otherwise one caller's automations would carry a
 * secret the webhook then rejects.
 */
export async function getOrCreateWebhookSecret(): Promise<string> {
  const existing = await getWebhookSecret();
  if (existing) return existing;

  const secret = randomBytes(32).toString('hex');
  await prisma.settings.create({ data: { key: WEBHOOK_SECRET_KEY, value: secret } }).catch(() => {
    // Created meanwhile by a concurrent caller; theirs is read back below.
  });
  const stored = await getWebhookSecret();
  if (stored) return stored;
  await prisma.settings.update({ where: { key: WEBHOOK_SECRET_KEY }, data: { value: secret } });
  return secret;
}

/** Constant-time comparison of a provided token against the configured secret. */
export function tokensMatch(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
