import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Midden',
  description: 'Cyber hunt and DCO attack reconstruction with terrain mapping.',
  base: '/Midden/',
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Docs', link: '/docs/' }
    ],
    sidebar: {
      '/docs/': [
        {
          text: 'Documentation',
          items: [
            { text: 'Overview', link: '/docs/' },
            { text: 'Deployment', link: '/docs/deploy' }
          ]
        }
      ]
    },
    search: {
      provider: 'local'
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/jacstrong/Midden' }]
  }
})
