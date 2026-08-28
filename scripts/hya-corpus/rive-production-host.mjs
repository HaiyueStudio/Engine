import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  decodeProductionWireValue,
  encodeProductionWireValue,
  RIVE_PRODUCTION_ADAPTER_PROTOCOL,
} from './rive-production-adapter-bridge.mjs';

const MAX_INPUT_BYTES = positiveInteger(process.env.RIVE_PRODUCTION_HOST_MAX_INPUT_BYTES ?? String(1024 * 1024 * 1024));
const kind = argument('--kind');
if (!['capability', 'official', 'hya'].includes(kind)) fail('--kind must be capability, official or hya.');
const providerPath = resolve(required(argument('--provider'), '--provider'));
const providerSha256 = hash(readFileSync(providerPath));
const gatewaySha256 = hash(readFileSync(fileURLToPath(import.meta.url)));
const input = await readStdin();
let envelope;
try { envelope = decodeProductionWireValue(JSON.parse(input.toString('utf8'))); }
catch (error) { fail(`Production host input is invalid JSON: ${bounded(error)}`); }
if (envelope?.protocol !== RIVE_PRODUCTION_ADAPTER_PROTOCOL) fail('Production host protocol is invalid.');
if (!['identity', 'capability-evaluation', 'capture'].includes(envelope?.operation)) fail('Production host operation is invalid.');
validateDescriptor(envelope.descriptor);

console.log = (...values) => console.error(...values);
console.info = (...values) => console.error(...values);
const provider = await import(`${pathToFileURL(providerPath).href}?sha256=${providerSha256}`);
let result;
if (envelope.operation === 'identity') {
  result = kind === 'capability'
    ? {
        ready: true, kind, adapterRevisionSha256: gatewaySha256,
        evaluatorRevisionSha256: providerSha256, nodeVersion: process.version,
        platform: process.platform, arch: process.arch,
      }
    : {
        ready: true, kind, revisionSha256: providerSha256, nodeVersion: process.version,
        platform: process.platform, arch: process.arch,
      };
} else if (kind === 'capability' && envelope.operation === 'capability-evaluation') {
  const evaluate = provider.evaluate ?? provider.capabilityEvaluator?.evaluate?.bind(provider.capabilityEvaluator);
  if (typeof evaluate !== 'function') fail('Capability provider must export evaluate() or capabilityEvaluator.evaluate().');
  result = await evaluate(envelope.request, { descriptor: envelope.descriptor });
} else if (kind !== 'capability' && envelope.operation === 'capture') {
  const named = kind === 'official' ? provider.officialCaptureAdapter : provider.hyaCaptureAdapter;
  const capture = provider.capture ?? named?.capture?.bind(named);
  if (typeof capture !== 'function') fail(`${kind} provider must export capture() or its named capture adapter.`);
  result = await capture(envelope.request, { descriptor: envelope.descriptor });
  if (result?.artifactBytesByPath instanceof Map) result = { ...result, artifactBytesByPath: [...result.artifactBytesByPath] };
  if (stableJson(result?.environment) !== stableJson(envelope.request?.environment)) {
    fail(`${kind} provider capture environment differs from the requested physical browser environment.`);
  }
} else {
  fail(`Host kind ${kind} cannot execute ${envelope.operation}.`);
}
if (!result || typeof result !== 'object') fail('Production provider result must be an object.');
const response = {
  protocol: RIVE_PRODUCTION_ADAPTER_PROTOCOL,
  operation: envelope.operation,
  status: 'completed',
  descriptor: envelope.descriptor,
  result,
};
process.stdout.write(`${JSON.stringify(encodeProductionWireValue(response))}\n`);

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) fail('Production host descriptor is missing.');
  if (kind === 'capability') {
    if (descriptor.adapterRevisionSha256 !== gatewaySha256) fail('Capability adapter revision does not match the production gateway bytes.');
    if (descriptor.evaluatorRevisionSha256 !== providerSha256) fail('Capability evaluator revision does not match the provider bytes.');
  } else if (descriptor.revisionSha256 !== providerSha256) {
    fail(`${kind} capture revision does not match the provider bytes.`);
  }
}

async function readStdin() {
  const chunks = []; let byteLength = 0;
  for await (const chunk of process.stdin) {
    byteLength += chunk.byteLength;
    if (byteLength > MAX_INPUT_BYTES) fail(`Production host input exceeded ${MAX_INPUT_BYTES} bytes.`);
    chunks.push(chunk);
  }
  if (byteLength === 0) fail('Production host input is empty.');
  return Buffer.concat(chunks);
}
function argument(name) { return process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1); }
function required(value, label) { if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required.`); return value; }
function positiveInteger(value) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) fail('RIVE_PRODUCTION_HOST_MAX_INPUT_BYTES must be a positive integer.'); return number; }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function bounded(value) { return String(value instanceof Error ? value.message : value).replace(/[\r\n]+/gu, ' ').slice(0, 512); }
function fail(message) { process.stderr.write(`[rive-production-host] ${message}\n`); process.exit(1); }
