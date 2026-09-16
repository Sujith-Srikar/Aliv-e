// @ts-check

import vercel from '@astrojs/vercel';
import { defineConfig } from 'astro/config';
import lenis from 'astro-lenis';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: vercel({}),
  integrations: [lenis()],
});
