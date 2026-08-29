import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runChromeWebGpuFixture } from '../webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OFFICIAL_JS_SHA256 = 'd25d57588f63382b662a00b54b73164f7dcda65759dfcfa1009931d3a1ae1714';
const OFFICIAL_WASM_SHA256 = '87d864c0efa264f287c3e6bf769b6ddf71d359bb0b3cef446aa0bc13ce4ffe32';
const CAPTURE_INDEX_SHA256 = '2cba454cb87ab205bf4d93d717217faaf93ecc1b816e5c21eeafb0bfb6a4ffb0';
const CAPTURE_BUNDLE_SHA256 = 'defa8d9b31d73de86ea007ee90e6113def70447275ccd126c4696721b653392a';
const SHARED_ENGINE_SHA256 = 'dc9d4d2261aecaed00b90890e64ff666bbda40051747d8170d84044aaa66d2e9';
const execute = promisify(execFile);

export async function captureWithNativeBrowser(mode, request) {
  if (!['official', 'hya'].includes(mode)) throw new TypeError(`Unknown capture mode ${String(mode)}.`);
  validateRequest(mode, request);
  await verifyCaptureFixture();
  if (mode === 'official') await verifyOfficialRuntime();
  const temporary = await mkdtemp(resolve(tmpdir(), `haiyue-rive-${mode}-capture-`));
  const runtimeBytes = mode === 'official' ? request.runtimeInput.bytes : request.runtimeInput.hyaBytes;
  const sourceRivBytes = mode === 'official' ? runtimeBytes : request.runtimeInput.sourceRivBytes;
  const semanticTopology = await buildOfficialSemanticTopology(sourceRivBytes, request.scenario.selection.artboard);
  const packageAssetDirectory = mode === 'hya'
    ? await materializeHyaPackageAssets(request.runtimeInput.packageBytes, temporary)
    : null;
  const payload = {
    mode,
    assetId: request.assetId,
    rivSha256: request.rivSha256,
    scenarioSha256: request.scenarioSha256,
    artifactPrefix: request.artifactPrefix,
    scenario: request.scenario,
    environment: request.environment,
    semanticTopology,
  };
  const previousChromePath = process.env.CHROME_PATH;
  process.env.CHROME_PATH = browserPath(request.environment.browser);
  const energySampler = await startNvidiaEnergySampler();
  try {
    await Promise.all([
      writeFile(resolve(temporary, 'payload.json'), `${JSON.stringify(payload)}\n`),
      writeFile(resolve(temporary, 'runtime.bin'), runtimeBytes),
    ]);
    const browserResult = await runChromeWebGpuFixture({
      root,
      fixture: 'examples/rive-production-capture/index.html',
      timeoutMs: 10 * 60_000,
      acceptedStatuses: ['passed'],
      mounts: [
        { prefix: '/capture-input', directory: temporary },
        ...(packageAssetDirectory ? [{ prefix: '/examples/rive-production-capture/assets', directory: packageAssetDirectory }] : []),
      ],
      crossOriginIsolation: true,
    });
    const capture = browserResult.capture;
    if (!capture || browserResult.mode !== mode) throw new Error(`${mode} browser host returned an invalid capture result.`);
    validateBrowserEvidence(browserResult, request.environment, capture.deviceEvidence);
    const entries = capture.artifactBytesByPath;
    if (!Array.isArray(entries)) throw new Error(`${mode} browser host did not return artifact bytes.`);
    const artifacts = new Map(entries.map(([path, base64]) => [path, Uint8Array.from(Buffer.from(base64, 'base64'))]));
    const metrics = {
      ...capture.metrics,
      rawBytes: runtimeBytes.byteLength,
      gzipBytes: gzipSync(runtimeBytes, { level: 9 }).byteLength,
    };
    const energy = await energySampler?.stop();
    if (energy) {
      metrics.energyMj = energy.energyMj;
      capture.measurement.energySource = energy.source;
      capture.diagnostics = capture.diagnostics.filter(value => value?.metric !== 'energyMj');
    }
    return {
      ...capture,
      environment: structuredClone(request.environment),
      metrics,
      artifactBytesByPath: artifacts,
    };
  } finally {
    await energySampler?.stop();
    if (previousChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = previousChromePath;
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function materializeHyaPackageAssets(packageBytes, temporary) {
  const modulePath = resolve(root, 'animation-spec/dist-test/rive/convert/package.js');
  if (!existsSync(modulePath)) throw new Error('HYA package decoder is unavailable for native capture.');
  const { decodeRiveHyaArchive } = await import(`${pathToFileURL(modulePath).href}?capture-package=${hash(packageBytes)}`);
  const files = decodeRiveHyaArchive(Uint8Array.from(packageBytes), { maxPackageBytes: 512 * 1024 * 1024, maxPackageFiles: 4096 });
  const directory = resolve(temporary, 'assets'); await mkdir(directory, { recursive: true });
  for (const file of files) {
    if (!file.path.startsWith('assets/')) continue;
    const name = file.path.slice('assets/'.length);
    if (!/^[a-f0-9]{64}$/u.test(name)) throw new Error(`HYA capture rejected non-content-addressed asset path ${file.path}.`);
    await writeFile(resolve(directory, name), file.bytes);
  }
  return directory;
}

async function buildOfficialSemanticTopology(rivBytes, artboardName) {
  const modulePath = resolve(root, 'animation-spec/dist-test/rive/import/index.js');
  if (!existsSync(modulePath)) throw new Error('Frozen Rive import runtime is unavailable for the topology oracle.');
  const { importFrozenRiv } = await import(`${pathToFileURL(modulePath).href}?topology=${hash(rivBytes)}`);
  const imported = await importFrozenRiv(Uint8Array.from(rivBytes));
  const objects = new Map(imported.ir.objects.map(value => [value.id, value]));
  const selectedIds = selectedArtboardObjectIds(imported, artboardName, objects);
  return {
    oracle: 'neutral-drawable-topology@1',
    items: imported.ir.drawables.filter(id => selectedIds.has(id)).map((id, drawOrder) => ({
      id,
      family: objects.get(id)?.family ?? 'unknown',
      drawOrder,
    })),
  };
}

function selectedArtboardObjectIds(imported, artboardName, objects) {
  let collecting = false; let found = false;
  const ids = new Set();
  for (const visit of imported.report.objects) {
    if (visit.sourceName === 'Artboard') {
      if (collecting) break;
      const object = objects.get(visit.neutralObjectId);
      const nameProperty = visit.properties.find(value => value.sourceName === 'name');
      const nameField = object?.properties.find(value => nameProperty?.neutralFieldIds?.includes(value.id));
      collecting = nameField?.value?.value === artboardName;
      found ||= collecting;
    }
    if (collecting) ids.add(visit.neutralObjectId);
  }
  if (!found) throw new Error(`Topology oracle could not resolve selected artboard ${String(artboardName)}.`);
  return ids;
}

async function startNvidiaEnergySampler() {
  let initial;
  try { initial = await readNvidiaPower(); } catch { return null; }
  let stopped = false; let completed = false;
  const samples = [{ at: performance.now(), watts: initial }];
  const sampling = (async () => {
    while (!stopped) {
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
      if (stopped) break;
      try { samples.push({ at: performance.now(), watts: await readNvidiaPower() }); } catch { /* preserve collected physical samples */ }
    }
  })();
  let result;
  return {
    async stop() {
      if (completed) return result;
      stopped = true; await sampling;
      try { samples.push({ at: performance.now(), watts: await readNvidiaPower() }); } catch { /* final sample is optional */ }
      completed = true;
      if (samples.length < 2) return null;
      let joules = 0;
      for (let index = 1; index < samples.length; index++) {
        const previous = samples[index - 1]; const current = samples[index];
        joules += ((previous.watts + current.watts) / 2) * ((current.at - previous.at) / 1000);
      }
      result = { energyMj: Math.max(0, joules * 1000), source: `nvidia-smi power.draw trapezoidal integration (${samples.length} samples, whole native capture)` };
      return result;
    },
  };
}

async function readNvidiaPower() {
  const { stdout } = await execute('nvidia-smi.exe', ['--query-gpu=power.draw', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 5_000 });
  const watts = Number(String(stdout).trim().split(/\r?\n/u)[0]);
  if (!Number.isFinite(watts) || watts <= 0) throw new Error('nvidia-smi did not report positive physical GPU power.');
  return watts;
}

function validateBrowserEvidence(result, environment, deviceEvidence) {
  const product = String(result.browserEvidence?.product ?? '');
  const version = product.split('/').at(-1);
  if (version !== environment.browserVersion) throw new Error(`Native browser version differs from requested environment: expected ${environment.browserVersion}, received ${product}.`);
  if (result.browserEvidence?.nativeBackend !== true) throw new Error('Native browser capture resolved a software graphics backend.');
  if (result.browserDiagnostics?.consoleErrorCount !== environment.consoleErrorCount || result.browserDiagnostics?.exceptionCount !== environment.exceptionCount) {
    throw new Error('Native browser diagnostics differ from the requested environment identity.');
  }
  if (JSON.stringify(deviceEvidence?.webgpu) !== JSON.stringify(environment.adapter)) throw new Error('Native WebGPU adapter identity differs from the requested environment.');
  if (!String(environment.gpu).includes(String(deviceEvidence?.webgl2?.renderer ?? ''))) throw new Error('Native WebGL2 renderer differs from the requested environment.');
}

function validateRequest(mode, request) {
  if (!request || typeof request !== 'object') throw new TypeError('Capture request is missing.');
  if (!request.environment?.physicalDevice || !['chrome', 'edge'].includes(request.environment?.browser)) throw new Error('Capture requires a declared physical Chrome/Edge environment.');
  if (mode === 'official' && (request.runtimeInput?.kind !== 'riv' || !(request.runtimeInput.bytes instanceof Uint8Array))) throw new TypeError('Official capture requires RIV bytes.');
  if (mode === 'hya' && (request.runtimeInput?.kind !== 'hya-package' || !(request.runtimeInput.hyaBytes instanceof Uint8Array) || !(request.runtimeInput.packageBytes instanceof Uint8Array) || !(request.runtimeInput.sourceRivBytes instanceof Uint8Array))) throw new TypeError('HYA capture requires exact HYA, package, and source RIV oracle bytes.');
}

async function verifyOfficialRuntime() {
  const jsPath = resolve(root, 'node_modules/@rive-app/webgl2/rive.js');
  const wasmPath = resolve(root, 'node_modules/@rive-app/webgl2/rive.wasm');
  if (!existsSync(jsPath) || !existsSync(wasmPath)) throw new Error('Pinned @rive-app/webgl2@2.40.0 runtime is not installed.');
  const [js, wasm] = await Promise.all([readFile(jsPath), readFile(wasmPath)]);
  if (hash(js) !== OFFICIAL_JS_SHA256 || hash(wasm) !== OFFICIAL_WASM_SHA256) throw new Error('Installed official Rive runtime bytes differ from the frozen tuple.');
}

async function verifyCaptureFixture() {
  const identities = [
    ['examples/rive-production-capture/index.html', CAPTURE_INDEX_SHA256],
    ['examples/rive-production-capture/bundle.js', CAPTURE_BUNDLE_SHA256],
    ['examples/shared/engine.js', SHARED_ENGINE_SHA256],
  ];
  for (const [path, expected] of identities) {
    const bytes = await readFile(resolve(root, path));
    if (hash(bytes) !== expected) throw new Error(`Production capture fixture differs from its pinned identity: ${path}.`);
  }
}

function browserPath(browser) {
  if (browser === 'edge') return process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  return process.env.GOOGLE_CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
