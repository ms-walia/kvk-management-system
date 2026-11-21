import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/erp/',
  plugins: [react()],
  build: { outDir: '../../hosting/erp', emptyOutDir: false },
  server: { port: 5173, host: true },
});
