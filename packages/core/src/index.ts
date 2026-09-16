/**
 * @midden/core — pure, I/O-free domain logic shared by the server and the web client.
 *
 * Nothing in this package may import node: builtins that do I/O, touch the DOM, or depend on
 * a runtime other than plain ECMAScript. That is what lets the same code run inside the
 * Fastify server, the React app, and the standalone HTML's Web Worker.
 */
export const CORE_VERSION = '0.1.0';

export { CASE_SCHEMA_V1, CASE_SCHEMA_V2 } from './schema/versions.js';

export * from './domain/types.js';
export * from './domain/schemas.js';
export * from './domain/reference.js';
export { uid } from './domain/ids.js';

export * from './time/time.js';
export * from './ip/ip.js';

export * from './ops/ops.js';
export * from './ops/reducer.js';
export * from './sync/protocol.js';

export * from './codec/casefile.js';
export { demoCaseState, DEMO_SUMMARY } from './demo/demoCase.js';

export * from './nmap/types.js';
export * from './nmap/schemas.js';
export * from './nmap/classify.js';
export * from './nmap/detect.js';
export * from './nmap/parseXml.js';
export * from './nmap/parseText.js';
export * from './nmap/layout.js';
export * from './nmap/synth.js';
export * from './nmap/command.js';

export * from './views/display.js';
export * from './views/derive.js';
export * from './views/graph.js';
export * from './report/report.js';
export * from './terrain/aggregate.js';
export * from './terrain/maplayout.js';
