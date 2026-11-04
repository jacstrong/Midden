/**
 * Write docs/openapi.json and docs/api-reference.md from the server's API description. A test
 * fails if these fall out of step with the server.
 *
 *   pnpm docs:api
 */
import { writeFileSync } from 'node:fs';
import { openApiDocument } from '../packages/server/src/openapi/spec.ts';
import { renderReference } from '../packages/server/src/openapi/render.ts';

const docs = new URL('../docs/', import.meta.url);
const doc = openApiDocument();
writeFileSync(new URL('openapi.json', docs), JSON.stringify(doc, null, 2) + '\n');
writeFileSync(new URL('api-reference.md', docs), renderReference(doc));
console.log('wrote docs/openapi.json and docs/api-reference.md');
