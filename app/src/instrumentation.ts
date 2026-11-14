/**
 * Runs once when the Next.js server starts: start the usage tracker, and stop it
 * cleanly when the server is stopped. Not awaited, so a Home Assistant that is
 * not up yet cannot hold up the server.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // First: with NEXT_MANUAL_SIG_HANDLE set, Next.js installs no handler of its
  // own, and node runs as PID 1 in the image, which ignores a signal nothing
  // handles. Were the tracker to fail to load, a stop would hang until killed.
  const { handleShutdownSignals } = await import('./lib/shutdown');
  handleShutdownSignals();
  const { startUsageTracker } = await import('./lib/usage/tracker');
  startUsageTracker().catch(err => console.error('[usage] Could not start the usage tracker:', err));
}
