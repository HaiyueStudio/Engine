import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from '../webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const oracleRoot = requiredPath('--oracle-root');
const sourceRoot = requiredPath('--source-root');
const outputArgument = argument('--out');
const edge = process.argv.includes('--edge');
verifyFile('rive.js', 'd25d57588f63382b662a00b54b73164f7dcda65759dfcfa1009931d3a1ae1714');
verifyFile('rive.wasm', '87d864c0efa264f287c3e6bf769b6ddf71d359bb0b3cef446aa0bc13ce4ffe32');
verifyFile('rive_fallback.wasm', '4890ed4a506742587909e847376587d44ac13454d60f58790b1f6729f8648b49');
const paths = walk(sourceRoot)
  .filter(path => path.toLowerCase().endsWith('.riv'))
  .filter(path => {
    const bytes = readFileSync(path);
    return bytes[4] === 7 && bytes[5] === 3;
  })
  .map(path => relative(sourceRoot, path).split('\\').join('/'))
  .sort();
if (paths.length === 0) throw new Error('Source root contains no `.riv` 7.3 diagnostic files.');
if (edge) {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  process.env.CHROME_PATH = edgePath;
}
const isolatedResults = [];
for (const [index, path] of paths.entries()) {
  console.log(`[rive-oracle] ${index + 1}/${paths.length} ${path}`);
  try {
    const result = sanitizeEvidence(await runOne(path));
    isolatedResults.push({ path, status: 'completed', result });
  } catch (error) {
    isolatedResults.push({
      path,
      status: 'browser-gate-failed',
      error: sanitizeText(String(error instanceof Error ? error.message : error)).slice(0, 2048),
    });
  }
}
const revision = git(['rev-parse', 'HEAD']);
const completed = isolatedResults.filter(value => value.status === 'completed');
const assetResults = completed.flatMap(value => value.result.results ?? []);
const report = {
  schemaVersion: 1,
  kind: 'haiyue-rive-official-load-diagnostic',
  formalEvidence: false,
  generatedAt: new Date().toISOString(),
  engineRevision: revision,
  engineDirty: git(['status', '--porcelain']).length > 0,
  browser: edge ? 'edge' : 'chrome',
  oracle: {
    package: '@rive-app/webgl2@2.40.0',
    riveJsSha256: 'd25d57588f63382b662a00b54b73164f7dcda65759dfcfa1009931d3a1ae1714',
    riveWasmSha256: '87d864c0efa264f287c3e6bf769b6ddf71d359bb0b3cef446aa0bc13ce4ffe32',
  },
  browserEvidence: completed.map(value => ({ path: value.path, evidence: value.result.browserEvidence })),
  resultCount: paths.length,
  loadedCount: assetResults.filter(value => value.status === 'loaded').length,
  rejectedCount: assetResults.filter(value => value.status === 'rejected').length,
  browserGateFailedCount: isolatedResults.filter(value => value.status === 'browser-gate-failed').length,
  ownerResidual: completed.reduce((total, value) => total + Number(value.result.ownerResidual ?? 0), 0),
  results: isolatedResults,
};
if (outputArgument) {
  const output = resolve(root, outputArgument);
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[rive-oracle] diagnostic load matrix written to ${relative(root, output)}.`);
}
console.log(`[rive-oracle] ${report.browser}: loaded=${report.loadedCount}/${report.resultCount}, rejected=${report.rejectedCount}, browser-gate-failed=${report.browserGateFailedCount}, owners=${report.ownerResidual}.`);

function runOne(path) {
  return runChromeWebGpuFixture({
    root,
    fixture: 'scripts/hya-corpus/rive-oracle-load-fixture.html',
    query: { assets: path },
    timeoutMs: 60_000,
    acceptedStatuses: ['passed'],
    mounts: [
      { prefix: '/oracle', directory: oracleRoot },
      { prefix: '/source', directory: sourceRoot },
    ],
  });
}

function sanitizeEvidence(value) {
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeEvidence(entry)]));
  }
  return typeof value === 'string' ? sanitizeText(value) : value;
}

function sanitizeText(value) {
  const normalizedRoot = root.split('\\').join('/');
  return value
    .split(root).join('<engine-root>')
    .split(normalizedRoot).join('<engine-root>')
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>');
}

function verifyFile(name, expectedHash) {
  const bytes = readFileSync(resolve(oracleRoot, name));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedHash) throw new Error(`Frozen oracle ${name} hash mismatch.`);
}

function walk(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function requiredPath(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required.`);
  return resolve(value);
}

function argument(name) {
  return process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function git(args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
