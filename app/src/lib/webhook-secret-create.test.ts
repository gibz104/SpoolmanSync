import './usage/test-fixtures';
import { it, expect } from 'vitest';
import prisma from '@/lib/db';
import { getOrCreateWebhookSecret, getWebhookSecret } from './webhook-secret';

it('gives concurrent callers the one secret the database holds', async () => {
  await prisma.settings.deleteMany({ where: { key: 'webhook_secret' } });
  const secrets = await Promise.all(Array.from({ length: 8 }, () => getOrCreateWebhookSecret()));
  expect(new Set(secrets).size).toBe(1);
  expect(secrets[0]).toBe(await getWebhookSecret());
  expect(await getOrCreateWebhookSecret()).toBe(secrets[0]);
});
