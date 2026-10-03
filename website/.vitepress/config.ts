import { realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import { readGuides } from './guides';

const REPO = 'https://github.com/jacstrong/Midden';
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const vueDir = realpathSync(fileURLToPath(new URL('../node_modules/vue', import.meta.url)));
const guides = readGuides(fileURLToPath(new URL('../../docs/', import.meta.url)));

// GitHub Pages serves a project site under /<repo>/; Cloudflare Pages and custom domains serve
// it at the root. The Pages workflow passes the right one in.
const base = `/${(process.env.SITE_BASE ?? '').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');

export default defineConfig({
  title: 'Midden',
  titleTemplate: ':title // MIDDEN',
  description:
    'Cyber hunt and DCO attack reconstruction with terrain mapping. Self-hosted, collaborative, or a single offline .html file.',
  lang: 'en',
  base,
  cleanUrls: true,
  appearance: 'force-dark',
  lastUpdated: true,

  // The site's source is the whole repository so that docs/ stays where it is, as plain
  // Markdown, and is read in place. Everything outside docs/ and website/ is excluded.
  srcDir: '..',
  srcExclude: ['!(docs|website)/**', '*.md'],
  rewrites: {
    'website/index.md': 'index.md',
    'website/guides.md': 'docs/index.md',
  },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['meta', { name: 'theme-color', content: '#06080e' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Midden' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Cyber hunt and DCO attack reconstruction with terrain mapping.',
      },
    ],
  ],

  markdown: {
    theme: 'synthwave-84',
    config(md) {
      // Docs are written to read on GitHub, so they may link to source files elsewhere in the
      // repository. Those are not pages on this site; send them to GitHub instead.
      md.core.ruler.push('repo_links', (state) => {
        const from = (state.env as { relativePath?: string }).relativePath;
        if (!from?.startsWith('docs/')) return;
        for (const block of state.tokens) {
          for (const tok of block.children ?? []) {
            if (tok.type !== 'link_open') continue;
            const href = tok.attrGet('href');
            if (!href || /^([a-z]+:|\/\/|#|\/)/i.test(href)) continue;
            const [path, hash = ''] = href.split('#');
            const target = posix.normalize(posix.join(posix.dirname(from), path!));
            if (target.startsWith('docs/')) continue;
            const kind = target.endsWith('/') ? 'tree' : 'blob';
            tok.attrSet('href', `${REPO}/${kind}/main/${target}${hash ? `#${hash}` : ''}`);
          }
        }
      });
    },
  },

  vite: {
    publicDir: fileURLToPath(new URL('../public', import.meta.url)),
    server: { fs: { allow: [repoRoot] } },
    // Pages compiled from docs/ import vue, but pnpm only links it under website/, which is not
    // an ancestor of docs/. Point every import at the website's copy.
    resolve: { alias: [{ find: /^vue(?=\/|$)/, replacement: vueDir }] },
  },

  themeConfig: {
    siteTitle: 'MIDDEN',
    nav: [
      { text: 'Docs', link: '/docs/', activeMatch: '^/docs/' },
      { text: 'Releases', link: `${REPO}/releases` },
    ],
    sidebar: {
      '/docs/': [
        {
          text: 'Guides',
          items: [
            { text: 'Overview', link: '/docs/' },
            ...guides.map(({ title, link }) => ({ text: title, link })),
          ],
        },
      ],
    },
    // Custom field, read by the GuideList component on the docs index.
    guides,
    socialLinks: [{ icon: 'github', link: REPO }],
    editLink: {
      pattern: `${REPO}/edit/main/:path`,
      text: 'Edit this page on GitHub',
    },
    outline: { level: [2, 3], label: 'On this page' },
    search: { provider: 'local' },
    footer: {
      message: 'Released under the Apache License 2.0.',
    },
  },
});
