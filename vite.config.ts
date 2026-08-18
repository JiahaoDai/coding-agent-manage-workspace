import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    proxy: {
      // Downstream SSE + upstream REST all live under /api on the Node server.
      '/api': 'http://localhost:4000',
    },
  },
});
