/**
 * Shutting down on SIGTERM/SIGINT. Node.js only: instrumentation.ts imports it
 * on the Node.js runtime, which keeps these Node APIs out of the Edge build.
 */
import { processGlobal } from '@/lib/process-global';

/** Inside the Supervisor's and Docker's 10 s stop timeout, so a Spoolman that hangs cannot hold the stop up. */
const SHUTDOWN_TIMEOUT_MS = 8_000;

/**
 * Next.js leaves these signals to us when NEXT_MANUAL_SIG_HANDLE is set (both
 * Dockerfiles set it), so a stop or update finishes a deduction already under
 * way and saves open prints, then exits 0. Without it Next.js handles them
 * itself, as before.
 */
export function handleShutdownSignals(): void {
  if (!process.env.NEXT_MANUAL_SIG_HANDLE) return;
  // Once per process, however many times instrumentation runs. The handlers
  // stay installed: a second signal is ignored, where with none left Node's
  // default would end the process mid-write.
  processGlobal('shutdown', () => {
    let started = false;
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        if (started) return;
        started = true;
        void shutdown(signal);
      });
    }
    return true;
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`[shutdown] ${signal}, finishing up`);
  setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
  try {
    const { usageTracker } = await import('@/lib/usage/tracker');
    await usageTracker()?.shutdown();
    const { default: prisma } = await import('@/lib/db');
    await prisma.$disconnect();
  } catch (err) {
    console.error('[shutdown] Could not finish cleanly:', err);
  } finally {
    process.exit(0);
  }
}
