import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Guide {
  /** Site path without the base, e.g. `/docs/deploy`. */
  link: string;
  /** The document's first `# ` heading, or the file name if it has none. */
  title: string;
  /** The first paragraph after the heading, joined onto one line. */
  summary: string;
}

/**
 * The guides in `docs/`, read straight from the Markdown so the folder stays plain files that
 * also read well on GitHub: no frontmatter, no sidebar config to keep in step.
 */
export function readGuides(docsDir: string): Guide[] {
  return readdirSync(docsDir)
    .filter((f) => f.endsWith('.md') && f !== 'index.md')
    .map((file) => {
      const lines = readFileSync(join(docsDir, file), 'utf8').split(/\r?\n/);
      const h1 = lines.findIndex((l) => /^#\s/.test(l));
      const title = h1 >= 0 ? lines[h1]!.replace(/^#\s+/, '').trim() : file.replace(/\.md$/, '');
      const para: string[] = [];
      for (const line of lines.slice(h1 + 1)) {
        if (line.trim() === '') {
          if (para.length) break;
          continue;
        }
        if (/^(#|```|[-*>|]|\d+\.)/.test(line.trim())) {
          if (para.length) break;
          continue;
        }
        para.push(line.trim());
      }
      const summary = para
        .join(' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[`*]/g, '');
      return { link: `/docs/${file.replace(/\.md$/, '')}`, title, summary };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}
