import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const legacyVersion = createHash('sha256')
  .update(readFileSync(new URL('./public/legacy/index.html', import.meta.url)))
  .digest('hex')
  .slice(0, 12);

export default defineConfig({
  base: process.env.VITE_APP_BASE_URL || '/',
  define: {
    __LEGACY_APP_VERSION__: JSON.stringify(legacyVersion),
  },
  plugins: [react()],
  server: {
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3001',
    },
  },
});
