import { z } from 'zod';

const str = z.string().default('');

export const ScriptOutputSchema = z.object({ id: str, output: str });

export const ScanPortSchema = z.object({
  port: z.coerce.number().int().nonnegative().default(0),
  proto: str.default('tcp'),
  state: str,
  name: str,
  product: str,
  version: str,
  extra: str,
  tunnel: str,
  cpe: z.array(z.string()).default([]),
  scripts: z.array(ScriptOutputSchema).default([]),
});

export const HopSchema = z.object({
  ttl: z.coerce.number().int().nonnegative().default(0),
  ip: str,
  host: str,
  rtt: str,
});

export const ScanHostSchema = z.object({
  ip: z.string().min(1),
  ipv6: str,
  mac: str,
  vendor: str,
  hostnames: z.array(z.string()).default([]),
  state: str.default('up'),
  reason: str,
  latency: str,
  distance: z.number().int().nullable().default(null),
  ports: z.array(ScanPortSchema).default([]),
  osName: str,
  osAccuracy: str,
  osFamily: str,
  osVendor: str,
  osType: str,
  trace: z.array(HopSchema).default([]),
  scripts: z.array(ScriptOutputSchema).default([]),
  uptime: str,
  bucket: str.default('Unknown'),
  role: str,
  flags: z.array(z.string()).default([]),
  openCount: z.number().int().nonnegative().default(0),
});
