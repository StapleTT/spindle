import { createServer } from 'node:net';
import type { TestContext } from 'node:test';

export const eicar = Buffer.from(
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
);
export async function scannerFixture(t: TestContext) {
  const controls = { unavailable: false, hold: false },
    received: Buffer[] = [];
  const server = createServer((socket) => {
    let pending = Buffer.alloc(0),
      command = false;
    const parts: Buffer[] = [];
    socket.on('error', () => {});
    socket.on('data', (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      if (!command) {
        if (pending.length < 10) return;
        if (pending.subarray(0, 10).toString() !== 'zINSTREAM\0') {
          socket.destroy();
          return;
        }
        pending = pending.subarray(10);
        command = true;
      }
      while (pending.length >= 4) {
        const size = pending.readUInt32BE();
        if (pending.length < 4 + size) return;
        const part = pending.subarray(4, 4 + size);
        pending = pending.subarray(4 + size);
        if (size) {
          parts.push(part);
          continue;
        }
        const content = Buffer.concat(parts);
        received.push(content);
        if (controls.hold) return;
        socket.end(
          controls.unavailable
            ? 'stream: scanner unavailable ERROR\0'
            : content.includes(eicar)
              ? 'stream: Eicar-Test-Signature FOUND\0'
              : 'stream: OK\0',
        );
        return;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Scanner fixture unavailable');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    controls,
    received,
    env: { CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(address.port) },
  };
}
