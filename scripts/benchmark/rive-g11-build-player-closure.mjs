import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from '../webgpu-gate/chrome-runner.mjs';
import { assertFormalRepositoryIdentity, captureRepositoryIdentity } from '../formal-evidence/repository-identity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCli();

async function runCli() {
  const outputDirectory = insideArtifacts(argument('--out-dir') ?? 'artifacts/rive-g11-formal/player-closure');
  const formal = process.argv.includes('--formal');
  const repositoryStart = captureRepositoryIdentity(root);
  if (formal) assertFormalRepositoryIdentity(repositoryStart, repositoryStart, { label: 'Engine' });
  const exampleDirectory = resolve(root, 'examples/live2d-hya');
  const packagedPaths = [
    'index.html', 'bundle.js', 'bundle.js.map',
    'assets/mascot.hya', 'assets/mascot.hydm', 'assets/mascot.png',
  ];
  for (const path of packagedPaths) readFileSync(resolve(exampleDirectory, path));
  const result = await runChromeWebGpuFixture({
    root,
    fixture: 'examples/live2d-hya/index.html',
    query: { recoverySmoke: 1 },
    timeoutMs: 120_000,
  });
  if (result.status !== 'passed' || result.cubismRuntimeInBrowser !== false || result.browserDiagnostics?.unclassifiedFailureCount !== 0) {
    throw new Error('Exact-HYA player browser verification did not complete without source-runtime diagnostics.');
  }
  mkdirSync(outputDirectory, { recursive: true });
  const tarballPath = resolve(outputDirectory, 'exact-hya-player.tgz');
  const bundlePath = resolve(exampleDirectory, 'bundle.js');
  const sourceMapPath = resolve(exampleDirectory, 'bundle.js.map');
  const networkPath = resolve(outputDirectory, 'network-requests.json');
  const tarEntries = packagedPaths.map(path => [`package/${path}`, readFileSync(resolve(exampleDirectory, path))]);
  writeFileSync(tarballPath, createTarGzip(tarEntries));
  const origin = new URL(result.browserEvidence.url).origin;
  const requests = (result.httpProvenance?.files ?? []).map(file => ({
    url: new URL(file.sourcePath, `${origin}/`).href,
    sourcePath: file.sourcePath,
    sha256: file.sha256,
    byteLength: file.byteLength,
    requestCount: file.requestCount,
  }));
  const network = {
    schemaVersion: 1,
    kind: 'haiyue-exact-hya-player-network-capture',
    engineRevision: repositoryStart.revision,
    engineDirty: repositoryStart.dirty,
    browser: result.browserEvidence,
    browserDiagnostics: result.browserDiagnostics,
    requestCount: result.httpProvenance?.requestCount ?? 0,
    requests,
  };
  writeFileSync(networkPath, `${JSON.stringify(network, null, 2)}\n`);
  if (formal) assertFormalRepositoryIdentity(repositoryStart, captureRepositoryIdentity(root), { label: 'Engine' });
  const report = {
    schemaVersion: 1,
    kind: 'haiyue-rive-g11-player-closure-inputs',
    engineRevision: repositoryStart.revision,
    engineDirty: repositoryStart.dirty,
    browser: result.browserEvidence,
    artifacts: {
      packedPlayerTarball: reference(tarballPath),
      browserBundle: reference(bundlePath),
      sourceMap: reference(sourceMapPath),
      networkRequests: reference(networkPath),
    },
  };
  writeFileSync(resolve(outputDirectory, 'inputs.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[rive-player-closure] browser=${result.browserEvidence.product}; requests=${requests.length}; output=${relative(root, outputDirectory)}.`);
}

export function createTarGzip(entries) {
  const chunks = [];
  for (const [name, value] of entries) {
    validateTarPath(name);
    const body = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    octal(header, 0o644, 100, 8); octal(header, 0, 108, 8); octal(header, 0, 116, 8);
    octal(header, body.byteLength, 124, 12); octal(header, 0, 136, 12);
    header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    chunks.push(header, body, Buffer.alloc((512 - (body.byteLength % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function octal(header, value, offset, length) { header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii'); }
function validateTarPath(value) { if (!value || value.includes('\\') || value.startsWith('/') || value.split('/').includes('..')) throw new Error(`Unsafe tar path ${value}.`); }
function argument(name) { return process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1); }
function insideArtifacts(value) {
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) throw new Error('--out-dir must be a relative POSIX path.');
  const path = resolve(root, value); const candidate = relative(root, path).split('\\').join('/');
  if (!candidate.startsWith('artifacts/')) throw new Error('--out-dir must remain under Engine/artifacts/.');
  return path;
}
function reference(path) { const bytes = readFileSync(path); return { path: relative(root, path).split('\\').join('/'), fileName: basename(path), sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength }; }
