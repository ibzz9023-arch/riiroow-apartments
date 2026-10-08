import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/riiroow-apartments/' : '/',
  plugins: [react()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    https: {
      key: fs.readFileSync('./192.168.100.96+2-key.pem'),
      cert: fs.readFileSync('./192.168.100.96+2.pem'),
    },
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
});
