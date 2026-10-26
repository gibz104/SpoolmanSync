/**
 * Runs once when the Next.js server starts: start the usage tracker. Not awaited,
 * so a Home Assistant that is not up yet cannot hold up the server.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startUsageTracker } = await import('./lib/usage/tracker');
  startUsageTracker().catch(err => console.error('[usage] Could not start the usage tracker:', err));
}
