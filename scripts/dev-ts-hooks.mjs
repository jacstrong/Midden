/**
 * Module resolve hook for running the TypeScript sources directly under `node --watch`.
 *
 * The sources import their siblings by the compiled name (`./config.js`), which is what the
 * emitted `dist` needs, but Node's type stripping does no path rewriting: it looks for
 * `config.js` on disk and fails. Map a `.js` specifier that has no file back onto the `.ts`
 * source next to it. Development only -- nothing in `dist` goes through this.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function tsSourceFor(specifier, parentURL) {
  if (!specifier.endsWith('.js')) return null;
  let url;
  try {
    url = new URL(specifier, parentURL);
  } catch {
    return null; // bare specifier, or relative with no parent
  }
  if (url.protocol !== 'file:') return null;
  if (existsSync(fileURLToPath(url))) return null;
  const ts = new URL(`${url.href.slice(0, -'.js'.length)}.ts`);
  return existsSync(fileURLToPath(ts)) ? ts.href : null;
}

export async function resolve(specifier, context, nextResolve) {
  const ts = tsSourceFor(specifier, context.parentURL);
  return nextResolve(ts ?? specifier, context);
}
