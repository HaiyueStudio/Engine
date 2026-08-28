import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertFormalRepositoryIdentity, captureRepositoryIdentity } from '../formal-evidence/repository-identity.mjs';
import { resolveProductionAdapterEnvironment, verifyProductionAdapterEnvironment } from './rive-production-adapter-bridge.mjs';
import { buildRiveConversionRuntime, buildRiveProductionCaptureFixture } from './rive-build-conversion-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function materializeFormalRiveAsset(asset, {
  temporaryDirectory,
  sourceDirectory = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const expectedBytes = asset?.riv?.byteLength;
  const expectedHash = asset?.riv?.sha256;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || !/^[a-f0-9]{64}$/u.test(expectedHash ?? '')) {
    throw new TypeError(`Formal asset ${String(asset?.id)} has invalid byte identity.`);
  }
  const sourceName = basename(new URL(asset.riv.sourceUrl).pathname);
  let bytes;
  let source;
  const localPath = sourceDirectory ? resolve(sourceDirectory, sourceName) : null;
  if (localPath && existsSync(localPath)) {
    bytes = await readFile(localPath);
    source = `local-cache:${sourceName}`;
  } else {
    if (typeof fetchImpl !== 'function') throw new Error(`Formal asset ${asset.id} is absent from the local source directory and fetch is unavailable.`);
    const response = await fetchImpl(asset.riv.sourceUrl, { cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error(`Formal asset ${asset.id} download failed with HTTP ${response.status}.`);
    bytes = Buffer.from(await response.arrayBuffer());
    source = asset.riv.sourceUrl;
  }
  if (bytes.byteLength !== expectedBytes) throw new Error(`Formal asset ${asset.id} byte length mismatch: expected ${expectedBytes}, received ${bytes.byteLength}.`);
  const actualHash = hash(bytes);
  if (actualHash !== expectedHash) throw new Error(`Formal asset ${asset.id} SHA-256 mismatch: expected ${expectedHash}, received ${actualHash}.`);
  const path = resolve(temporaryDirectory, `${safeId(asset.id)}.riv`);
  await writeFile(path, bytes);
  return Object.freeze({ assetId: asset.id, path, source, sha256: actualHash, byteLength: bytes.byteLength });
}

export function validateDeviceMatrixEnvironment(environment, { deviceClass, browser }) {
  const violations = [];
  if (environment?.deviceClass !== deviceClass) violations.push(`environment deviceClass must be ${deviceClass}`);
  if (environment?.browser !== browser) violations.push(`environment browser must be ${browser}`);
  if (environment?.physicalDevice !== true) violations.push('environment must identify a physical device');
  if (environment?.browserLogCaptured !== true) violations.push('environment must attest captured browser logs');
  if (environment?.consoleErrorCount !== 0) violations.push('environment consoleErrorCount must be 0');
  if (environment?.exceptionCount !== 0) violations.push('environment exceptionCount must be 0');
  if (!isWindows10Plus(environment?.os)) violations.push('environment OS must be Windows 10 or later');
  if (violations.length > 0) throw new Error(`Device matrix environment is invalid:\n- ${violations.join('\n- ')}`);
  return Object.freeze({ ...environment });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`Formal Rive device matrix requires Node.js 22 or later; observed ${process.version}.`);
  await buildRiveConversionRuntime();
  await buildRiveProductionCaptureFixture();
  const repositoryStart = captureRepositoryIdentity(root);
  assertFormalRepositoryIdentity(repositoryStart, repositoryStart, { label: 'Engine' });
  const deviceClass = required(argument('--device-class'), '--device-class');
  const browser = required(argument('--browser'), '--browser');
  if (!['windows-10-plus-device-a', 'windows-10-plus-device-b'].includes(deviceClass)) throw new Error('--device-class is outside the formal workload matrix.');
  if (!['chrome', 'edge'].includes(browser)) throw new Error('--browser must be chrome or edge.');
  const environmentPath = resolve(required(argument('--environment'), '--environment'));
  const environment = validateDeviceMatrixEnvironment(JSON.parse(await readFile(environmentPath, 'utf8')), { deviceClass, browser });
  const outputRoot = formalOutputPath(required(argument('--out-dir'), '--out-dir'));
  const sourceDirectory = argument('--source-dir') ? resolve(argument('--source-dir')) : null;
  const hostConfigPath = resolve(required(argument('--host-config'), '--host-config'));
  const productionEnvironment = resolveProductionAdapterEnvironment({ ...process.env, RIVE_PRODUCTION_HOST_CONFIG_PATH: hostConfigPath });
  await Promise.all(['capability', 'official', 'hya'].map(kind => verifyProductionAdapterEnvironment(kind, productionEnvironment)));
  const manifest = JSON.parse(await readFile(resolve(root, 'animation-spec/corpus/rive/rive-g11-corpus-manifest.json'), 'utf8'));
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'haiyue-rive-formal-inputs-'));
  const frozenEnvironmentPath = resolve(temporaryDirectory, 'environment.json');
  await writeFile(frozenEnvironmentPath, `${JSON.stringify(environment, null, 2)}\n`);
  const materialized = [];
  const failures = [];
  try {
    for (const asset of manifest.formalAssets ?? []) materialized.push(await materializeFormalRiveAsset(asset, { temporaryDirectory, sourceDirectory }));
    for (const [index, input] of materialized.entries()) {
      const asset = manifest.formalAssets.find(value => value.id === input.assetId);
      console.log(`[rive-device-matrix] ${index + 1}/${materialized.length} ${asset.id} on ${deviceClass}/${browser}`);
      try {
        await run(process.execPath, [
          resolve(root, 'scripts/hya-corpus/rive-run-differential-trace.mjs'),
          `--riv=${input.path}`,
          `--scenario=${resolve(root, asset.workloadScenario.path)}`,
          `--out-dir=${resolve(outputRoot, asset.id)}`,
          `--environment=${frozenEnvironmentPath}`,
          `--capability-evaluator=${resolve(root, 'scripts/hya-corpus/rive-production-capability-evaluator.mjs')}`,
          `--official-capture-adapter=${resolve(root, 'scripts/hya-corpus/rive-production-official-capture-adapter.mjs')}`,
          `--hya-capture-adapter=${resolve(root, 'scripts/hya-corpus/rive-production-hya-capture-adapter.mjs')}`,
          `--asset-id=${asset.id}`,
          '--formal',
        ], { ...process.env, ...productionEnvironment, RIVE_PRODUCTION_HOST_CONFIG_PATH: hostConfigPath });
      } catch (error) {
        failures.push({ assetId: asset.id, error: error instanceof Error ? error.message : String(error) });
        console.error(`[rive-device-matrix] ${asset.id} failed formal admission; continuing the fixed matrix.`);
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    assertFormalRepositoryIdentity(repositoryStart, captureRepositoryIdentity(root), { label: 'Engine' });
  }
  console.log(`[rive-device-matrix] attempted ${materialized.length}/${manifest.formalAssets.length} traces for ${deviceClass}/${browser}; failed=${failures.length}; inputs removed.`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[rive-device-matrix] ${failure.assetId}: ${failure.error}`);
    process.exitCode = 1;
  }
}

function run(command, args, environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: 'inherit', windowsHide: true, shell: false });
    child.once('error', rejectRun);
    child.once('exit', code => code === 0 ? resolveRun() : rejectRun(new Error(`Rive trace child exited with ${String(code)}.`)));
  });
}
function formalOutputPath(value) {
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) throw new Error('--out-dir must be a relative POSIX path inside artifacts/.');
  const path = resolve(root, value); const candidate = relative(root, path).split('\\').join('/');
  if (!candidate.startsWith('artifacts/') || !path.startsWith(`${root}${sep}`)) throw new Error('--out-dir must remain under Engine/artifacts/.');
  return path;
}
function argument(name) { return process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1); }
function required(value, label) { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} is required.`); return value; }
function safeId(value) { if (!/^[a-z0-9][a-z0-9-]*$/u.test(value ?? '')) throw new TypeError(`Unsafe formal asset id ${String(value)}.`); return value; }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function isWindows10Plus(value) { const match = /^Windows\s+(\d+)(?:\D|$)/iu.exec(String(value)); return match !== null && Number(match[1]) >= 10; }
