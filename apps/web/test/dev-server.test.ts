import assert from 'node:assert/strict';
import { createServer as createHttpServer, get } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import viteConfig from '../vite.config.js';

test('web bind address is independent of the API and allows only the configured app hostname', async () => {
  const keys = ['WEB_HOST', 'HOST', 'PORT', 'APP_URL'] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  try {
    assert.equal(typeof viteConfig, 'function');
    if (typeof viteConfig !== 'function') return;
    Object.assign(process.env, {
      WEB_HOST: '',
      HOST: '127.0.0.1',
      PORT: '3000',
      APP_URL: 'http://127.0.0.1:5173',
    });
    const local = await viteConfig({ command: 'serve', mode: 'test' });
    assert.equal(local.server?.host, '127.0.0.1');
    assert.equal(local.server?.port, 5173);
    assert.equal(local.server?.proxy?.['/api'], 'http://127.0.0.1:3000');

    Object.assign(process.env, {
      WEB_HOST: '0.0.0.0',
      APP_URL: 'https://spindle.example.test',
    });
    const lan = await viteConfig({ command: 'serve', mode: 'test' });
    assert.equal(lan.server?.host, '0.0.0.0');
    assert.deepEqual(lan.server?.allowedHosts, ['spindle.example.test']);
    assert.equal(lan.server?.proxy?.['/api'], 'http://127.0.0.1:3000');
    assert.equal(lan.server?.strictPort, true);

    const api = createHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'synthetic-ok' }));
    });
    let web: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
      const apiAddress = api.address();
      assert.ok(apiAddress && typeof apiAddress !== 'string');
      process.env.PORT = String(apiAddress.port);
      const proxied = await viteConfig({ command: 'serve', mode: 'test' });
      web = await createServer({
        ...proxied,
        configFile: false,
        root: fileURLToPath(new URL('../', import.meta.url)),
        logLevel: 'silent',
        server: { ...proxied.server, port: 0, strictPort: false, hmr: false },
      });
      await web.listen();
      const address = web.httpServer?.address();
      assert.ok(address && typeof address !== 'string');
      assert.equal(address.address, '0.0.0.0');
      const url = `http://127.0.0.1:${address.port}`;
      const request = (path: string, host = 'spindle.example.test') =>
        new Promise<{ status: number | undefined; body: string }>(
          (resolve, reject) => {
            get(`${url}${path}`, { headers: { host } }, (response) => {
              let body = '';
              response.setEncoding('utf8');
              response.on('data', (chunk) => {
                body += chunk;
              });
              response.on('end', () =>
                resolve({ status: response.statusCode, body }),
              );
              response.on('error', reject);
            }).on('error', reject);
          },
        );
      assert.equal((await request('/')).status, 200);
      const health = await request('/api/health');
      assert.equal(health.status, 200);
      assert.deepEqual(JSON.parse(health.body), { status: 'synthetic-ok' });
      assert.equal((await request('/', 'untrusted.example.test')).status, 403);
    } finally {
      await web?.close();
      await new Promise<void>((resolve, reject) =>
        api.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
