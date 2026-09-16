import type { ScanHost, ScanRunMeta } from '@midden/core';
import source from '../generated/nmap.worker.js?raw';
import { spawnWorker } from './spawn';
import type { ParseResponse } from './nmap.worker';

export interface ParseOutcome {
  hosts: ScanHost[];
  meta: ScanRunMeta;
}

/** Parse an uploaded nmap file off the main thread. `onProgress` reports hosts seen so far. */
export async function parseNmapFile(
  file: File,
  onProgress?: (hosts: number) => void,
): Promise<ParseOutcome> {
  // Read on the main thread: a data:-URL worker cannot read a local file in WebKit.
  const buffer = await file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const w = spawnWorker(source, 'nmap');
    const hosts: ScanHost[] = [];
    w.onmessage = (e: MessageEvent<ParseResponse>) => {
      const m = e.data;
      if (m.t === 'hosts') hosts.push(...m.hosts);
      else if (m.t === 'progress') onProgress?.(m.hosts);
      else if (m.t === 'done') {
        w.terminate();
        resolve({ hosts, meta: m.meta });
      } else if (m.t === 'error') {
        w.terminate();
        reject(new Error(m.message));
      }
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'nmap worker failed'));
    };
    w.postMessage({ t: 'parse', buffer }, [buffer]);
  });
}

/** Proves the data-URL worker runs in this engine; surfaced for the standalone e2e check. */
export function runWorkerSelfTest(): void {
  try {
    const w = spawnWorker(source, 'nmap-selftest');
    w.onmessage = (e: MessageEvent<ParseResponse>) => {
      if (e.data.t === 'pong') document.documentElement.dataset.worker = `pong:${e.data.echo}`;
      w.terminate();
    };
    w.onerror = () => {
      document.documentElement.dataset.worker = 'error';
    };
    w.postMessage({ t: 'ping', echo: 'ping' });
  } catch {
    document.documentElement.dataset.worker = 'error';
  }
}
