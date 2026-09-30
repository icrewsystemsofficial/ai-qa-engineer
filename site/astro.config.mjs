// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

// Deployed to GitHub Pages as a project site: https://icrewsystemsofficial.github.io/ai-qa-engineer/
// The base path must match the repo name so asset and link URLs resolve.
export default defineConfig({
  site: 'https://icrewsystemsofficial.github.io',
  base: '/ai-qa-engineer',
  integrations: [
    starlight({
      title: 'AI QA Engineer',
      description:
        'A Chrome + Firefox extension that captures everything you need to file a bug report — console, network, interactions, DOM, screenshots, and video — into a self-contained zip.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/icrewsystemsofficial/ai-qa-engineer',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/icrewsystemsofficial/ai-qa-engineer/edit/main/site/',
      },
      sidebar: [
        { label: 'Overview', link: '/' },
        { label: 'Guide', slug: 'guide' },
        { label: 'CLI', slug: 'cli' },
        { label: 'Development', slug: 'development' },
        { label: 'Privacy', slug: 'privacy' },
      ],
    }),
  ],
});
