import { defineConfig } from 'astro/config';

// One codebase, two mounts: root on production, /<repo>/ on GitHub Pages staging.
export default defineConfig({
  base: process.env.PAGES_BASE || '/',
  build: { inlineStylesheets: 'never' },
  server: { host: true },
  vite: {
    server: {
      allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app', '.ngrok.io', '.ngrok.app'],
    },
  },
});
