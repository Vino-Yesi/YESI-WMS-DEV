import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
// optional inspect plugin
// import { inspectAttr } from 'kimi-plugin-inspect-react'
import { VitePWA } from 'vite-plugin-pwa'

/** True when `tauri dev` / `tauri build` sets TAURI_ENV_* — skip SW to avoid webview conflicts */
const isTauriBuild = !!process.env.TAURI_ENV_PLATFORM || !!process.env.TAURI_ENV_DEBUG

/**
 * Circular-chunk fix:
 * Recharts/Dexie depend on React. Splitting them into separate manual chunks
 * caused Rollup cycles (vendor-react <-> vendor-charts / vendor-db).
 * Keep React + Dexie + Recharts in one chunk; isolate only independent heavy vendors.
 */
export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : './',
  plugins: [
    // inspectAttr(),
    react(),
    // PWA for web/iOS only — omitted entirely for Tauri desktop builds
    ...(!isTauriBuild
      ? [
          VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'icon-192.png',
        'icon-512.png',
        'apple-touch-icon.png',
        'apple-touch-icon-152.png',
        'apple-touch-icon-167.png',
      ],
      manifest: {
        id: '/',
        name: 'YESI Lite WMS',
        short_name: 'YESI Lite',
        description: 'Instant fulfillment warehouse app — offline-first, installable on iPhone & iPad',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        orientation: 'any',
        start_url: './',
        scope: './',
        lang: 'en',
        categories: ['business', 'productivity', 'utilities'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
        ],
        // Prefer dark UI chrome on supporting browsers
        prefer_related_applications: false,
      },
      workbox: {
        // Cache app shell + common static assets for offline floor use
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,json,webp}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.destination === 'document',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'yesi-pages',
              networkTimeoutSeconds: 4,
            },
          },
          {
            urlPattern: ({ request }) =>
              request.destination === 'script' || request.destination === 'style',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'yesi-assets' },
          },
          {
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'yesi-images',
              expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      devOptions: {
        // Enable SW in dev only when testing install flow
        enabled: false,
      },
    }),
        ]
      : []),
  ],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    allowedHosts: true,
    cors: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    cors: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  clearScreen: false,
  /**
   * Unit tests (vitest) live in `src/__tests__` and run against a DOM shim +
   * fake IndexedDB. Playwright owns `e2e/` and is invoked separately
   * (`npm run test:e2e`), so it is excluded here to keep a bare `vitest`
   * run from failing on browser-driver specs.
   */
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    restoreMocks: true,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
    dedupe: ['react', 'react-dom', 'react-router', 'react-router-dom'],
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('pdfjs-dist') || id.includes('pdf-lib')) return 'vendor-pdf';
          if (id.includes('html5-qrcode')) return 'vendor-scanner';
          if (id.includes('@supabase/supabase-js') || id.includes('@supabase/')) return 'vendor-supabase';
          if (id.includes('framer-motion') || id.includes('lucide-react')) return 'vendor-ui';
          if (
            id.includes('recharts') ||
            id.includes('d3-') ||
            id.includes('dexie') ||
            id.includes('react-dom') ||
            id.includes('react-router') ||
            id.includes('node_modules/react/') ||
            id.includes('node_modules\\react\\') ||
            id.includes('/scheduler/')
          ) {
            return 'vendor-react';
          }
        },
      },
    },
  },
}));
