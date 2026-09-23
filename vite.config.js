import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, res) => {
            if (res && typeof res.writeHead === 'function' && !res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'starting', message: 'Backend engine starting...' }));
            }
          });
        },
      },
      '/ws/live': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
        configure: (proxy, _options) => {
          proxy.on('error', () => {});
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    minify: 'esbuild',
  },
});

