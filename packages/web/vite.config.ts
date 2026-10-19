import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read the CLI package's version at build time so the web bundle can
// display it (lets users see at a glance which version is rendering,
// vs guessing from `solix --version` + browser cache state).
const cliPkg = JSON.parse(
  readFileSync(resolve(__dirname, '../cli/package.json'), 'utf8'),
) as { version: string };
const SOLIX_VERSION = cliPkg.version;

export default defineConfig({
  define: {
    __SOLIX_VERSION__: JSON.stringify(SOLIX_VERSION),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Generate placeholder icons at build time using vite-plugin-pwa's
      // pwaAssets workflow would be ideal, but for V1 we ship two square
      // PNGs from public/icons/ and call it good.
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Solix — the control layer for your coding agents',
        short_name: 'Solix',
        description:
          'The control layer for your coding agents. Solix holds every risky command until you approve it, and shows what the fleet is spending.',
        start_url: '/',
        display: 'standalone',
        background_color: '#0a0e1a',
        theme_color: '#7c5cff',
        icons: [
          {
            src: '/icons/solix-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icons/solix-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/icons/solix-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Do NOT precache the app shell (js/css/html). Solix is served by
        // its own local server, which is always up whenever the UI is — so
        // precaching the shell bought nothing but the classic PWA failure:
        // after `solix` upgrades (or a rebuild), the service worker kept
        // serving the OLD bundle until it eventually updated, making fixes
        // look like they hadn't shipped. Precache only the icons/manifest
        // for installability; the shell always comes fresh from the network,
        // and `navigateFallback: null` stops the SW from serving a cached
        // index.html (the server owns navigation).
        globPatterns: ['**/*.{png,svg,ico,webmanifest}'],
        navigateFallback: null,
        navigateFallbackDenylist: [/^\/api/, /^\/events/, /^\/ws/],
      },
    }),
  ],
  server: {
    port: 4243,
    proxy: {
      '/api': 'http://127.0.0.1:4242',
      '/events': 'http://127.0.0.1:4242',
      '/ws': {
        target: 'ws://127.0.0.1:4242',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
