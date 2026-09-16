/** Scan upload, promotion into the case, and linking. Works in both hosted and standalone modes. */
import {
  caseHostByIp,
  hostIps,
  netKey,
  uid,
  type Host,
  type ScanMeta,
  type TerrainHostSummary,
} from '@midden/core';
import { apiUpload, ApiError } from './api';
import { downloadText } from './download';
import { parseNmapFile } from '../workers/nmap';
import { useCaseStore } from '../store/useCaseStore';
import { useTerrain } from '../store/useTerrain';
import { MemoryTerrain, scanMetaFromParse } from './terrain';
import { toast } from '../store/useToasts';

/**
 * Upload a scan. Hosted: POST the file, the server parses it and broadcasts the ops. Standalone:
 * parse in a worker, keep the hosts in memory, and record the scan in case state.
 */
export async function uploadScan(
  file: File,
  opts: { name?: string; phase?: string } = {},
): Promise<ScanMeta | null> {
  const cs = useCaseStore.getState();
  const terrain = useTerrain.getState();
  if (!cs.capabilities.fileBased && cs.caseId) {
    const form = new FormData();
    form.append('file', file, file.name);
    if (opts.name) form.append('name', opts.name);
    if (opts.phase) form.append('phase', opts.phase);
    try {
      const r = await apiUpload<{ scan: ScanMeta }>(`/api/cases/${cs.caseId}/scans`, form);
      toast(`Uploaded ${file.name} — parsing`);
      return r.scan;
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Upload failed', 'bad');
      return null;
    }
  }
  try {
    const { hosts, meta } = await parseNmapFile(file);
    const id = uid('scan');
    const scan = scanMetaFromParse(
      id,
      opts.name || file.name,
      meta,
      hosts.length,
      new Date().toISOString(),
    );
    const store = terrain.store instanceof MemoryTerrain ? terrain.store : new MemoryTerrain();
    store.put(id, hosts);
    if (!(terrain.store instanceof MemoryTerrain)) terrain.setStore(store);
    const r = await cs.dispatch({ type: 'scan.add', scan });
    if (!r.ok) return null;
    terrain.bump();
    toast(`Parsed ${hosts.length} hosts from ${file.name}`);
    return scan;
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not parse that file', 'bad');
    return null;
  }
}

export async function removeScan(scanId: string): Promise<void> {
  const cs = useCaseStore.getState();
  const terrain = useTerrain.getState();
  if (!cs.capabilities.fileBased && cs.caseId) {
    try {
      await terrain.store.removeScan(scanId);
      toast('Scan removed', 'warn');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not remove the scan', 'bad');
      return;
    }
  } else {
    await terrain.store.removeScan(scanId);
    const r = await cs.dispatch({ type: 'scan.remove', id: scanId });
    if (!r.ok) return;
    toast('Scan removed', 'warn');
  }
  terrain.bump();
}

/** The case host currently linked to an address, if any. */
export function linkedHostId(ip: string): string | null {
  return caseHostByIp(useCaseStore.getState().state).get(ip) ?? null;
}

/** Build a case host from a scanned host: hostname, OS and role carry over, status starts unknown. */
export function hostFromTerrain(
  h: TerrainHostSummary,
  scanId: string,
): { host: Host; source: { scanId: string; ip: string } } {
  const short = h.hostnames[0]?.split('.')[0] ?? '';
  return {
    host: {
      id: uid('h'),
      name: short || h.ip,
      ip: h.ip,
      os: h.osName,
      role: h.role,
      zone: netKey(h.ip),
      crit: 'moderate',
      status: 'unknown',
      owner: '',
      tags: [],
      notes: h.flags.length ? `Flagged by scan: ${h.flags.join('; ')}` : '',
    },
    source: { scanId, ip: h.ip },
  };
}

/** Promote scanned hosts into the case, skipping any address already linked. */
export async function promoteHosts(hosts: TerrainHostSummary[], scanId: string): Promise<number> {
  const cs = useCaseStore.getState();
  const linked = caseHostByIp(cs.state);
  const fresh = hosts.filter((h) => !linked.has(h.ip));
  if (!fresh.length) {
    toast('Those hosts are already in the case', 'warn');
    return 0;
  }
  const ops = fresh.map((h) => {
    const { host, source } = hostFromTerrain(h, scanId);
    return { type: 'host.add' as const, host, source };
  });
  const r = await cs.dispatch(ops.length === 1 ? ops[0]! : { type: 'batch', ops });
  if (!r.ok) return 0;
  toast(
    fresh.length === 1
      ? `Added ${fresh[0]!.ip} to the case`
      : `Added ${fresh.length} hosts to the case`,
  );
  return fresh.length;
}

/** Attach an extra address to an existing case host (DHCP move, second NIC). */
export async function linkHostToIp(hostId: string, ip: string): Promise<void> {
  const cs = useCaseStore.getState();
  const h = cs.state.hosts[hostId];
  if (!h) return;
  if (hostIps(h.ip).includes(ip)) return;
  const r = await cs.dispatch({ type: 'link.set', hostId, ip });
  if (r.ok) toast(`Linked ${ip} to ${h.name}`);
}

export async function unlinkHostFromIp(hostId: string, ip: string): Promise<void> {
  const cs = useCaseStore.getState();
  const r = await cs.dispatch({ type: 'link.remove', hostId, ip });
  if (r.ok) toast(`Unlinked ${ip}`);
}

/** Download the alive-host list for the next scan phase (-iL). */
export async function downloadTargets(scanId: string, scanName: string): Promise<void> {
  const ips = await useTerrain.getState().store.targets(scanId);
  if (!ips.length) {
    toast('This scan has no live hosts to target', 'warn');
    return;
  }
  downloadText(
    `${scanName.replace(/[^\w.-]+/g, '_')}-targets.txt`,
    ips.join('\n') + '\n',
    'text/plain;charset=utf-8',
  );
  toast(`${ips.length} targets downloaded`);
}
