/**
 * Plain-text references in task descriptions, comments and case notes: `T-123` task numbers,
 * http(s) links, and `@username` mentions (usernames may be e-mail addresses under OIDC).
 * The UI renders tokens as links; the server reads mentions to notify people.
 */

export type RefToken =
  | { kind: 'text'; text: string }
  | { kind: 'task'; text: string; num: number }
  | { kind: 'url'; text: string; href: string }
  | { kind: 'mention'; text: string; username: string };

const RE =
  /(https?:\/\/[^\s<>"'`]+)|(?<![\w-])T-(\d{1,9})(?![\w-])|(?<![\w@.])@([A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)?)/g;

/** Trailing punctuation that ends a sentence rather than a link or name. */
const TRAILING = /[.,;:!?)\]}]+$/;

export function tokenizeRefs(text: string): RefToken[] {
  const out: RefToken[] = [];
  let last = 0;
  const pushText = (t: string): void => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev?.kind === 'text') prev.text += t;
    else out.push({ kind: 'text', text: t });
  };
  for (const m of text.matchAll(RE)) {
    const start = m.index;
    let raw = m[0];
    const trail = m[1] || m[3] ? (TRAILING.exec(raw)?.[0] ?? '') : '';
    if (trail) raw = raw.slice(0, -trail.length);
    pushText(text.slice(last, start));
    if (m[1]) out.push({ kind: 'url', text: raw, href: raw });
    else if (m[2]) out.push({ kind: 'task', text: raw, num: Number(m[2]) });
    else out.push({ kind: 'mention', text: raw, username: raw.slice(1) });
    pushText(trail);
    last = start + m[0].length;
  }
  pushText(text.slice(last));
  return out;
}

/** Usernames mentioned in a text, lower-cased and de-duplicated. */
export function mentionsIn(text: string): string[] {
  const out = new Set<string>();
  for (const t of tokenizeRefs(text)) if (t.kind === 'mention') out.add(t.username.toLowerCase());
  return [...out];
}

/** Task numbers referenced in a text, de-duplicated, in order of appearance. */
export function taskRefsIn(text: string): number[] {
  const out = new Set<number>();
  for (const t of tokenizeRefs(text)) if (t.kind === 'task') out.add(t.num);
  return [...out];
}
