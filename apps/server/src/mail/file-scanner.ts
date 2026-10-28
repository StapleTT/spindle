import { once } from 'node:events';
import { createConnection } from 'node:net';

// Operator-only endpoint: no file bytes are sent to public scanning services.
export async function scanFile(
  source: AsyncIterable<Buffer>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const port = Number(env.CLAMAV_PORT ?? 3310);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid scanner port');
  const socket = createConnection({
    host: env.CLAMAV_HOST ?? '127.0.0.1',
    port,
  });
  let response = '';
  const result = new Promise<'clean' | 'infected'>((resolve, reject) => {
    socket.on('error', reject);
    socket.on('data', (data: Buffer) => {
      response += data.toString('utf8');
      if (response.length > 4096)
        return reject(new Error('Invalid scanner response'));
      if (!response.includes('\0')) return;
      const answer = response.slice(0, response.indexOf('\0'));
      if (answer === 'stream: OK') resolve('clean');
      else if (/^stream: .+ FOUND$/.test(answer)) resolve('infected');
      else reject(new Error('Scan unavailable'));
    });
    socket.on('end', () => {
      if (!response.includes('\0')) reject(new Error('Scan ended'));
    });
  });
  // Consume rejection while the producer is still writing.
  void result.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Scan timed out'));
      socket.destroy();
    }, 45000);
  });
  const exchange = async () => {
    await once(socket, 'connect');
    const write = async (data: Buffer) => {
      if (socket.destroyed) throw new Error('Scan ended');
      await new Promise<void>((resolve, reject) =>
        socket.write(data, (error) => (error ? reject(error) : resolve())),
      );
    };
    await write(Buffer.from('zINSTREAM\0'));
    for await (const data of source) {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      await write(length);
      await write(data);
    }
    await write(Buffer.alloc(4));
    return await result;
  };
  try {
    return await Promise.race([exchange(), deadline]);
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
