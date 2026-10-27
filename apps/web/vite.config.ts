import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../../', import.meta.url)), [
    'HOST',
    'PORT',
  ]);
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': `http://${env.HOST || '127.0.0.1'}:${env.PORT || '3000'}`,
      },
    },
  };
});

import { fileURLToPath } from 'node:url';
