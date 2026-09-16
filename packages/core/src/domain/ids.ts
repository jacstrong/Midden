/** Short, sortable-enough unique id with a type prefix, e.g. `ev_k3j9x2a1b7`. */
export function uid(prefix: string, random: () => number = Math.random): string {
  const r = random().toString(36).slice(2, 9).padEnd(7, '0');
  const t = Date.now().toString(36).slice(-3);
  return `${prefix}_${r}${t}`;
}
