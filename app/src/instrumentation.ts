/**
 * Runs once when the Next.js server starts: start the usage tracker. Not awaited,
 * so a Home Assistant that is not up yet cannot hold up the server.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startUsageTracker, usageTracker } = await import('./lib/usage/tracker');
  startUsageTracker().catch(err => console.error('[usage] Could not start the usage tracker:', err));

  // Next.js leaves these to us (NEXT_MANUAL_SIG_HANDLE in the Dockerfiles), so
  // a stop or update finishes a deduction already under way and saves open
  // prints, then exits 0. The timer stays inside the Supervisor's and Docker's
  // 10 s stop timeout, so a Spoolman that hangs cannot hold the stop up.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, async () => {
      console.log(`[shutdown] ${signal}, finishing up`);
      setTimeout(() => process.exit(0), 8_000).unref();
      try {
        await usageTracker()?.shutdown();
        const { default: prisma } = await import('./lib/db');
        await prisma.$disconnect();
      } catch (err) {
        console.error('[shutdown] Could not finish cleanly:', err);
      } finally {
        process.exit(0);
      }
    });
  }
}
