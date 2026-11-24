import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// The till talks to the API on the same machine. In development Vite serves the app on 5173 and forwards /api to the
// API; in production the API serves the built files itself, so there is nothing to configure.
const api = process.env.API_URL ?? 'http://127.0.0.1:3000';
const webPort = Number(process.env.WEB_PORT ?? 5173);

/** Writes dist/sw.js: sw.template.js with the list of the app's files, and a version that changes whenever they do. */
function serviceWorker(): Plugin {
  return {
    name: 'till-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = [...new Set(['/index.html', ...Object.keys(bundle).map((n) => `/${n}`), '/manifest.webmanifest', '/icon.svg'])].filter(
        // The source maps are for developers, and the old .woff fonts are only a fallback for browsers the till does not use.
        (n) => !n.endsWith('.map') && !n.endsWith('.woff'),
      );
      const version = createHash('sha256').update(files.sort().join('\n')).digest('hex').slice(0, 12);
      const source = readFileSync(new URL('./sw.template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version)
        .replace("'__PRECACHE__'", JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  // /uploads is where product pictures are served from.
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/uploads': { target: api, changeOrigin: false },
      // the browser tests' fake printer lives on the test API (nothing answers here in real use)
      '/__e2e': { target: api, changeOrigin: false },
    },
  },
  preview: {
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/uploads': { target: api, changeOrigin: false },
      // the browser tests' fake printer lives on the test API (nothing answers here in real use)
      '/__e2e': { target: api, changeOrigin: false },
    },
  },
  build: { sourcemap: true },
});
