import { defineConfig } from 'vite';

const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return;
          if (id.includes('/monaco-editor/')) return 'monaco';
          if (id.includes('/@xterm/')) return 'xterm';
          if (id.includes('/fflate/')) return 'fflate';
        },
      },
    },
  },
  server: {
    port: 4173,
    headers: coiHeaders,
  },
  preview: {
    port: 4173,
    headers: coiHeaders,
  },
  worker: {
    format: 'es',
  },
});
