import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createExamplesServer, lanIPv4Addresses, parseOptions } from './serve-examples-lan.mjs';

test('parseOptions defaults to LAN HTTPS and requires explicit HTTP mode', () => {
  const secure = parseOptions([], {});
  assert.equal(secure.host, '0.0.0.0');
  assert.equal(secure.port, 8443);
  assert.equal(secure.protocol, 'https');

  const insecure = parseOptions(['--http'], {});
  assert.equal(insecure.port, 3000);
  assert.equal(insecure.protocol, 'http');
});

test('parseOptions accepts CLI and environment configuration', () => {
  const options = parseOptions(
    ['--port=9443', '--cert', 'cert.pem', '--key=key.pem'],
    { HAIYUE_EXAMPLES_LAN_HOST: '192.0.2.10' },
  );
  assert.equal(options.host, '192.0.2.10');
  assert.equal(options.port, 9443);
  assert.match(options.certificate, /cert\.pem$/);
  assert.match(options.privateKey, /key\.pem$/);
});

test('LAN address discovery excludes loopback and duplicates', () => {
  assert.deepEqual(
    lanIPv4Addresses({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [
        { address: '192.168.1.20', family: 'IPv4', internal: false },
        { address: '192.168.1.20', family: 4, internal: false },
      ],
    }),
    ['192.168.1.20'],
  );
});

test('HTTP diagnostic mode serves allowlisted files and rejects repository paths', async context => {
  const root = await mkdtemp(join(tmpdir(), 'haiyue-examples-lan-'));
  const examples = join(root, 'examples');
  await mkdir(examples);
  await writeFile(join(examples, 'index.html'), '<!doctype html><title>HaiYue</title>');
  await writeFile(join(examples, 'data.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(root, 'package.json'), '{"private":true}');
  const server = await createExamplesServer({
    protocol: 'http',
    mounts: [{ prefix: '/examples', directory: examples }],
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  const redirect = await request(`${origin}/`);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, '/examples/');

  const page = await request(`${origin}/examples/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(page.body.toString(), /HaiYue/);

  const range = await request(`${origin}/examples/data.bin`, { Range: 'bytes=1-2' });
  assert.equal(range.status, 206);
  assert.equal(range.headers['content-range'], 'bytes 1-2/4');
  assert.deepEqual(range.body, Buffer.from([1, 2]));

  assert.equal((await request(`${origin}/package.json`)).status, 404);
  assert.equal((await request(`${origin}/examples/..%2fpackage.json`)).status, 403);
});

test('default mounts expose runtime assets without exposing repository metadata', async context => {
  const server = await createExamplesServer({ protocol: 'http' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  assert.equal((await request(`${origin}/examples/`)).status, 200);
  assert.equal((await request(`${origin}/engine/dist/geometry.js`)).status, 200);
  assert.equal((await request(`${origin}/extensions/dist/gltf.js`)).status, 200);
  assert.equal((await request(`${origin}/animation-spec/`)).status, 200);
  assert.equal((await request(`${origin}/animation-spec/viewer.html`)).status, 200);
  assert.equal((await request(`${origin}/animation-spec/samples/manifest.json`)).status, 200);
  assert.equal(
    (await request(`${origin}/animation-spec/samples/transform-position.hya`)).headers['content-type'],
    'application/vnd.haiyue.animation',
  );
  const dashboardReport = JSON.parse(await readFile(
    new URL('../examples/hya-corpus-dashboard/report.json', import.meta.url),
    'utf8',
  ));
  const localReferences = dashboardReport.samples
    .flatMap(sample => sample.frames.map(frame => frame.referenceUrl))
    .filter(url => url.startsWith('/animation-spec/corpus/references/'));
  assert.ok(localReferences.length > 0);
  for (const referenceUrl of localReferences) {
    const corpusReference = await request(`${origin}${referenceUrl}`);
    assert.equal(corpusReference.status, 200, referenceUrl);
    assert.equal(corpusReference.headers['content-type'], 'image/png', referenceUrl);
    assert.ok(corpusReference.body.length > 0, referenceUrl);
  }
  assert.equal((await request(`${origin}/animation-spec/corpus/results/latest.json`)).status, 404);
  assert.equal((await request(`${origin}/node_modules/draco3dgltf/draco_decoder_gltf.wasm`)).status, 200);
  assert.equal((await request(`${origin}/favicon.ico`)).status, 204);
  assert.equal((await request(`${origin}/package.json`)).status, 404);
  assert.equal((await request(`${origin}/.git/config`)).status, 404);
  assert.equal((await request(`${origin}/.cert/haiyue-lan-key.pem`)).status, 404);
  assert.equal((await request(`${origin}/animation-spec/src/types.ts`)).status, 404);
});

function request(url, headers = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const operation = get(url, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        resolveRequest({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
      });
    });
    operation.on('error', rejectRequest);
  });
}
