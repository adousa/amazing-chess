import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `/api` is proxied to the FastAPI backend. To use the Prism mock instead, set
// VITE_API_BASE=http://127.0.0.1:4010 (see README / `npm run dev:mock`).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
});
