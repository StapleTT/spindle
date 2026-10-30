import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../../', import.meta.url)), [
    'HOST',
    'PORT',
    'WEB_HOST',
    'APP_URL',
  ]);
  return {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          app: fileURLToPath(new URL('index.html', import.meta.url)),
          landing: fileURLToPath(
            new URL('landing/index.html', import.meta.url),
          ),
        },
      },
    },
    server: {
      host: env.WEB_HOST || '127.0.0.1',
      allowedHosts: env.APP_URL ? [new URL(env.APP_URL).hostname] : [],
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': `http://${env.HOST || '127.0.0.1'}:${env.PORT || '3000'}`,
      },
    },
  };
});
