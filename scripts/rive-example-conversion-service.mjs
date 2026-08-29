import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRiveConversionRuntime } from './hya-corpus/rive-build-conversion-runtime.mjs';
import { evaluate as evaluateProductionCapabilities } from './hya-corpus/rive-production-capability-provider.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'animation-spec/corpus/rive/rive-g11-corpus-manifest.json');
const providerPath = resolve(root, 'scripts/hya-corpus/rive-production-capability-provider.mjs');
const routePrefix = '/api/rive-hya-compare/convert/';
const maximumRequestBytes = 64 * 1024 * 1024;
let runtimePromise;
let manifestPromise;

export async function convertOfficialRiveExample(assetId, input, signal = new AbortController().signal) {
  if (!(input instanceof Uint8Array)) throw new TypeError('Rive example conversion input must be Uint8Array.');
  const manifest = await loadManifest();
  const asset = manifest.formalAssets.find(value => value.id === assetId);
  if (!asset) throw new RangeError(`Unknown formal Rive asset ${assetId}.`);
  if (input.byteLength !== asset.riv.byteLength || sha256(input) !== asset.riv.sha256) {
    throw new Error(`Rive bytes do not match the formal identity for ${assetId}.`);
  }
  const scenario = JSON.parse(await readFile(resolve(root, asset.workloadScenario.path), 'utf8'));
  const conversion = await loadConversionRuntime();
  const providerRevision = sha256(await readFile(providerPath));
  const descriptor = Object.freeze({
    adapterId: 'haiyue-rive-example-production-evaluator',
    adapterRevisionSha256: providerRevision,
    evaluatorId: 'rive-production-capability-provider',
    evaluatorRevisionSha256: providerRevision,
    optionsRevision: 'rive-7.3-production-v3',
  });
  const capabilityEvaluator = Object.freeze({
    descriptor,
    evaluate(request, _signal) {
      return evaluateProductionCapabilities(request, { descriptor });
    },
  });
  const result = await conversion.convertRivBytesToHya(Uint8Array.from(input), {
    capabilityEvaluator,
    selection: scenario.selection,
    signal,
  });
  const files = conversion.decodeRiveHyaArchive(result.packageBytes, {
    maxPackageBytes: result.packageBytes.byteLength,
    maxPackageFiles: result.manifest.files.length + 1,
  });
  const filesByPath = new Map(files.map(file => [file.path, file]));
  const embeddedAssets = result.manifest.assets.filter(asset => asset.kind === 'embedded').map(asset => {
    const file = filesByPath.get(asset.path);
    if (!file || file.bytes.byteLength !== asset.byteLength || sha256(file.bytes) !== asset.sha256) {
      throw new Error(`Converted package asset ${asset.path} failed its manifest identity.`);
    }
    return Object.freeze({
      path: asset.path,
      mimeType: asset.mimeType,
      sha256: asset.sha256,
      byteLength: asset.byteLength,
      bytes: file.bytes,
    });
  });
  return Object.freeze({ ...result, embeddedAssets: Object.freeze(embeddedAssets) });
}

export async function handleRiveExampleConversionRequest(request, response) {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith(routePrefix)) return false;
  const cors = conversionCorsHeaders(request);
  if (request.headers.origin && cors === null) {
    sendJson(response, 403, { status: 'failed', error: 'Cross-origin Rive conversion is restricted to the same origin or loopback development origins.' });
    return true;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Cache-Control': 'no-store',
      ...cors,
    });
    response.end();
    return true;
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { status: 'failed', error: 'Method not allowed.' }, { Allow: 'POST, OPTIONS', ...cors });
    return true;
  }
  const controller = new AbortController();
  request.once('aborted', () => controller.abort(new Error('Client aborted Rive conversion.')));
  try {
    const assetId = decodeURIComponent(url.pathname.slice(routePrefix.length));
    const input = await readBoundedRequest(request, maximumRequestBytes);
    const result = await convertOfficialRiveExample(assetId, input, controller.signal);
    sendJson(response, 200, {
      status: 'passed',
      assetId,
      hyaBase64: Buffer.from(result.hyaBytes).toString('base64'),
      assets: result.embeddedAssets.map(asset => ({
        path: asset.path,
        mimeType: asset.mimeType,
        sha256: asset.sha256,
        byteLength: asset.byteLength,
        base64: Buffer.from(asset.bytes).toString('base64'),
      })),
      report: result.report,
    }, cors);
  } catch (error) {
    const status = error instanceof RangeError || error instanceof TypeError ? 400 : 422;
    sendJson(response, status, { status: 'failed', error: error instanceof Error ? error.message : String(error) }, cors);
  }
  return true;
}

function conversionCorsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin) return {};
  let parsed;
  try { parsed = new URL(origin); } catch { return null; }
  const sameHost = parsed.host === request.headers.host;
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (!sameHost && !loopback) return null;
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

async function loadManifest() {
  manifestPromise ??= readFile(manifestPath, 'utf8').then(JSON.parse);
  return manifestPromise;
}

async function loadConversionRuntime() {
  runtimePromise ??= buildRiveConversionRuntime().then(path => import(`${pathToFileURL(path).href}?example-converter=1`));
  return runtimePromise;
}

function readBoundedRequest(request, maximumBytes) {
  return new Promise((resolveRead, rejectRead) => {
    const declared = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > maximumBytes) {
      rejectRead(new RangeError(`Rive conversion request exceeds ${maximumBytes} bytes.`));
      request.resume();
      return;
    }
    const chunks = []; let byteLength = 0; let rejected = false;
    request.on('data', chunk => {
      if (rejected) return;
      byteLength += chunk.byteLength;
      if (byteLength > maximumBytes) {
        rejected = true;
        rejectRead(new RangeError(`Rive conversion request exceeds ${maximumBytes} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', error => { if (!rejected) rejectRead(error); });
    request.once('end', () => { if (!rejected) resolveRead(new Uint8Array(Buffer.concat(chunks, byteLength))); });
  });
}

function sendJson(response, status, value, headers = {}) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': String(bytes.byteLength),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(bytes);
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
