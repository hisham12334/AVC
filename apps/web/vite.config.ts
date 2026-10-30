import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  // `pnpm dev` runs the API on 3000; forward API calls so the UI talks to the real backend.
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
