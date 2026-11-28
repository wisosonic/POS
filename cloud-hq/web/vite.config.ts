import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development Vite serves the screen on 5174 and forwards /api to HQ; in production HQ serves the built files itself, so there is nothing to configure.
const hq = process.env.HQ_URL ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true, proxy: { '/api': { target: hq, changeOrigin: false } } },
  build: { sourcemap: false },
});
