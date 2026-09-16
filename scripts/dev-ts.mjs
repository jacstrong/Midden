/** `node --import ./scripts/dev-ts.mjs` -- see dev-ts-hooks.mjs. */
import { register } from 'node:module';

register('./dev-ts-hooks.mjs', import.meta.url);
