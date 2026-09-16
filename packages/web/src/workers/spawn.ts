/**
 * Spawn a prebuilt worker (see vite.worker.config.ts) from a data: URL.
 * Works identically in the hosted bundle and the standalone file:// build.
 */
export function spawnWorker(source: string, name?: string): Worker {
  const b64 = btoa(unescape(encodeURIComponent(source)));
  return new Worker(
    `data:text/javascript;base64,${b64}`,
    name === undefined ? undefined : { name },
  );
}
