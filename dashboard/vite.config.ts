import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Bun resolves workspace packages' raw .ts through "exports"; Vite does not
    // reliably, so alias them explicitly.
    alias: {
      '@oat/api-client': r('../packages/api-client/src/index.ts'),
      '@oat/api-sdk': r('../packages/api-sdk/src/index.ts'),
      '@oat/contracts': r('../packages/contracts/src/index.ts'),
      '@oat/types': r('../packages/types/src/index.ts'),
    },
  },
  optimizeDeps: {
    exclude: ['@oat/api-client', '@oat/api-sdk', '@oat/contracts', '@oat/types'],
  },
  server: {
    port: 5173,
    // Bound to all interfaces so another machine on the LAN — an emulator host,
    // for instance — can reach the dashboard during device verification.
    host: true,
    fs: { allow: [r('..')] },
    // Same-origin in dev: no CORS config, and cookie behaviour matches production.
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { outDir: 'dist', sourcemap: true },
});
