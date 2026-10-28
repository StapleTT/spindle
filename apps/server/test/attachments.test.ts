import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { scanFile } from '../src/mail/file-scanner.js';
import { CHUNK_BYTES, fixedChunks } from '../src/mail/file-storage.js';
import { eicar, scannerFixture } from './scanner-fixture.js';

test('attachment streaming preserves bytes across arbitrary chunk boundaries with a fixed memory bound', async () => {
  const parts = [
    Buffer.alloc(17, 1),
    Buffer.alloc(CHUNK_BYTES * 3 + 15, 2),
    Buffer.alloc(7, 3),
  ];
  const output: Buffer[] = [];
  for await (const part of fixedChunks(Readable.from(parts))) {
    assert.ok(part.length <= CHUNK_BYTES);
    output.push(part);
  }
  assert.deepEqual(Buffer.concat(output), Buffer.concat(parts));
});
test('ClamAV INSTREAM distinguishes clean, infected and unavailable without a permissive fallback', async (t) => {
  const scanner = await scannerFixture(t);
  assert.equal(
    await scanFile(Readable.from([Buffer.from('safe bytes')]), scanner.env),
    'clean',
  );
  assert.equal(
    await scanFile(
      Readable.from([eicar.subarray(0, 12), eicar.subarray(12)]),
      scanner.env,
    ),
    'infected',
  );
  scanner.controls.unavailable = true;
  await assert.rejects(
    scanFile(Readable.from([Buffer.from('safe')]), scanner.env),
  );
  assert.deepEqual(scanner.received[1], eicar);
});
