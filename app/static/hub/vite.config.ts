import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base: Forge serves Custom UI from a sub-path.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'build', emptyOutDir: true },
  server: { fs: { allow: ['../..', '../../../engine'] } },
});
