import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Phase 16 — admin webapp. Standalone Vite SPA (not part of the mobile app).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
  },
});
