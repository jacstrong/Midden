/** Row insertion for terrain, shared by the worker thread and the in-process fallback. */
import { ipSortKey, netKey, type ScanHost, type ScanRunMeta } from '@midden/core';
import type { Db } from '../db/db.js';

export const BATCH = 500;

export class TerrainInserter {
  private batch: ScanHost[] = [];
  inserted = 0;

  constructor(
    private readonly db: Db,
    private readonly scanId: string,
    private readonly bits = 24,
  ) {}

  add(h: ScanHost): void {
    this.batch.push(h);
    if (this.batch.length >= BATCH) this.flush();
  }

  flush(): void {
    if (!this.batch.length) return;
    const rows = this.batch;
    this.batch = [];
    this.db.transaction(() => {
      for (const h of rows) this.insertOne(h);
    });
    this.inserted += rows.length;
  }

  private insertOne(h: ScanHost): void {
    const r = this.db.run(
      `INSERT OR IGNORE INTO scan_hosts (scan_id, ip, ip_sort, net_key, ipv6, mac, vendor, hostnames, state, reason, latency, distance, uptime,
         os_name, os_accuracy, os_family, os_vendor, os_type, bucket, role, flags, open_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      this.scanId,
      h.ip,
      ipSortKey(h.ip),
      netKey(h.ip, this.bits),
      h.ipv6,
      h.mac,
      h.vendor,
      JSON.stringify(h.hostnames),
      h.state,
      h.reason,
      h.latency,
      h.distance,
      h.uptime,
      h.osName,
      h.osAccuracy,
      h.osFamily,
      h.osVendor,
      h.osType,
      h.bucket,
      h.role,
      JSON.stringify(h.flags),
      h.openCount,
    );
    if (!Number(r.changes)) return; // duplicate ip within one scan: keep the first
    const hostId = Number(r.lastInsertRowid);
    for (const p of h.ports) {
      this.db.run(
        'INSERT OR IGNORE INTO scan_ports (scan_host_id, port, proto, state, name, product, version, extra, tunnel, cpe, scripts) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        hostId,
        p.port,
        p.proto,
        p.state,
        p.name,
        p.product,
        p.version,
        p.extra,
        p.tunnel,
        JSON.stringify(p.cpe),
        JSON.stringify(p.scripts).slice(0, 32_768),
      );
    }
    for (const hop of h.trace)
      this.db.run(
        'INSERT OR IGNORE INTO scan_hops (scan_host_id, ttl, ip, host, rtt) VALUES (?,?,?,?,?)',
        hostId,
        hop.ttl,
        hop.ip,
        hop.host,
        hop.rtt,
      );
    for (const s of h.scripts)
      this.db.run(
        'INSERT OR IGNORE INTO scan_scripts (scan_host_id, script_id, output) VALUES (?,?,?)',
        hostId,
        s.id,
        s.output.slice(0, 65_536),
      );
  }
}

export function finishScan(db: Db, scanId: string, meta: ScanRunMeta, hostsInserted: number): void {
  db.run(
    `UPDATE scans SET status = 'ready', nmap_args = ?, nmap_version = ?, started_at = ?, finished_at = ?, elapsed_s = ?,
       hosts_up = ?, hosts_down = ?, hosts_total = ?, error = '' WHERE id = ?`,
    meta.args,
    meta.version,
    meta.start,
    meta.end,
    meta.elapsed ? Number(meta.elapsed) : null,
    meta.hostsUp ?? hostsInserted,
    meta.hostsDown ?? 0,
    meta.hostsTotal ?? meta.hostsUp ?? hostsInserted,
    scanId,
  );
}

export function failScan(db: Db, scanId: string, message: string): void {
  db.run(
    `UPDATE scans SET status = 'failed', error = ? WHERE id = ?`,
    message.slice(0, 1000),
    scanId,
  );
}

export function deleteScanRows(db: Db, scanId: string): void {
  db.run('DELETE FROM scan_hosts WHERE scan_id = ?', scanId);
}
