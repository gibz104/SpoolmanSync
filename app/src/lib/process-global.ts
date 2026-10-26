/**
 * One value per process, however many times a module is evaluated.
 *
 * The usage tracker starts from `instrumentation.ts`, which Next evaluates in a
 * module graph of its own, apart from the route handlers. Anything both sides
 * must share (the SSE event emitter, the alert-check queue, the tracker itself)
 * therefore lives on globalThis rather than in module scope.
 */
export function processGlobal<T>(key: string, create: () => T): T {
  const store = ((globalThis as { __spoolmansync?: Map<string, unknown> }).__spoolmansync ??= new Map());
  if (!store.has(key)) store.set(key, create());
  return store.get(key) as T;
}
