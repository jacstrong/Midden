/** Test helper: reshape a ScanHost into nmap2map.py's --json record for parity comparisons. */
import type { ScanHost } from './types.js';

export function toLegacyShape(h: ScanHost): Record<string, unknown> {
  return {
    ip: h.ip,
    ipv6: h.ipv6,
    mac: h.mac,
    vendor: h.vendor,
    hostnames: h.hostnames,
    state: h.state,
    reason: h.reason,
    latency: h.latency,
    distance: h.distance,
    ports: h.ports.map((p) => ({
      port: p.port,
      proto: p.proto,
      state: p.state,
      name: p.name,
      product: p.product,
      version: p.version,
      extra: p.extra,
      tunnel: p.tunnel,
    })),
    os_name: h.osName,
    os_accuracy: h.osAccuracy,
    os_family: h.osFamily,
    os_vendor: h.osVendor,
    os_type: h.osType,
    trace: h.trace,
    scripts: h.scripts,
    uptime: h.uptime,
    bucket: h.bucket,
    role: h.role,
    flags: h.flags,
    open_count: h.openCount,
  };
}
