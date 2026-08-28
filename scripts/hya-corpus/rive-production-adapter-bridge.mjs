import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const RIVE_PRODUCTION_ADAPTER_PROTOCOL = 'haiyue-rive-production-adapter@1';
const HASH = /^[a-f0-9]{64}$/u;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

export function createProductionCapabilityEvaluator({ descriptor, invoke = invokeProductionHost } = {}) {
  validateCapabilityDescriptor(descriptor);
  return Object.freeze({
    descriptor: Object.freeze({ ...descriptor }),
    async evaluate(request, signal) {
      const response = await invoke({ operation: 'capability-evaluation', descriptor, request, signal });
      return validateHostResponse(response, 'capability-evaluation', descriptor).result;
    },
  });
}

export function createProductionCaptureAdapter({ descriptor, invoke = invokeProductionHost } = {}) {
  validateCaptureDescriptor(descriptor);
  return Object.freeze({
    descriptor: Object.freeze({ ...descriptor }),
    async capture(request) {
      const response = await invoke({ operation: 'capture', descriptor, request, signal: request.signal });
      const result = validateHostResponse(response, 'capture', descriptor).result;
      const entries = result?.artifactBytesByPath;
      if (!Array.isArray(entries)) throw new TypeError('Production capture host must return artifactBytesByPath as [path, bytes] entries.');
      const artifactBytesByPath = new Map();
      for (const [index, entry] of entries.entries()) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !(entry[1] instanceof Uint8Array)) {
          throw new TypeError(`Production capture artifact entry ${index} is invalid.`);
        }
        if (artifactBytesByPath.has(entry[0])) throw new TypeError(`Production capture returned duplicate artifact path ${entry[0]}.`);
        artifactBytesByPath.set(entry[0], entry[1]);
      }
      return Object.freeze({ ...result, artifactBytesByPath });
    },
  });
}

export function productionAdapterFromEnvironment(kind, environment = process.env) {
  const configuration = productionAdapterConfiguration(kind, environment);
  const { descriptor, command, args, timeoutMs, maxOutputBytes } = configuration;
  const invoke = options => invokeProductionHost({ ...options, command, args, timeoutMs, maxOutputBytes });
  return kind === 'capability'
    ? createProductionCapabilityEvaluator({ descriptor, invoke })
    : createProductionCaptureAdapter({ descriptor, invoke });
}

export function productionAdapterConfiguration(kind, environment = process.env) {
  environment = resolveProductionAdapterEnvironment(environment);
  const prefix = {
    capability: 'RIVE_CAPABILITY_EVALUATOR',
    official: 'RIVE_OFFICIAL_CAPTURE',
    hya: 'RIVE_HYA_CAPTURE',
  }[kind];
  if (!prefix) throw new TypeError(`Unknown production adapter kind ${String(kind)}.`);
  const descriptor = parseJson(environment[`${prefix}_DESCRIPTOR_JSON`], `${prefix}_DESCRIPTOR_JSON`);
  const command = required(environment[`${prefix}_COMMAND`], `${prefix}_COMMAND`);
  const args = environment[`${prefix}_ARGS_JSON`] === undefined
    ? []
    : parseJson(environment[`${prefix}_ARGS_JSON`], `${prefix}_ARGS_JSON`);
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new TypeError(`${prefix}_ARGS_JSON must be a JSON string array.`);
  const timeoutMs = positiveInteger(environment[`${prefix}_TIMEOUT_MS`] ?? '120000', `${prefix}_TIMEOUT_MS`);
  const maxOutputBytes = positiveInteger(environment[`${prefix}_MAX_OUTPUT_BYTES`] ?? String(DEFAULT_MAX_OUTPUT_BYTES), `${prefix}_MAX_OUTPUT_BYTES`);
  if (kind === 'capability') validateCapabilityDescriptor(descriptor); else validateCaptureDescriptor(descriptor);
  return Object.freeze({ kind, prefix, descriptor: Object.freeze({ ...descriptor }), command, args: Object.freeze([...args]), timeoutMs, maxOutputBytes });
}

export function resolveProductionAdapterEnvironment(environment = process.env) {
  const configPath = environment.RIVE_PRODUCTION_HOST_CONFIG_PATH;
  if (configPath === undefined) return environment;
  required(configPath, 'RIVE_PRODUCTION_HOST_CONFIG_PATH');
  let parsed;
  try { parsed = JSON.parse(readFileSync(resolve(configPath), 'utf8')); }
  catch (error) { throw new TypeError(`RIVE_PRODUCTION_HOST_CONFIG_PATH is invalid: ${bounded(error)}`); }
  if (parsed?.schemaVersion !== 1 || parsed?.kind !== 'haiyue-rive-production-host-configuration' || !parsed?.environment || typeof parsed.environment !== 'object' || Array.isArray(parsed.environment)) {
    throw new TypeError('RIVE_PRODUCTION_HOST_CONFIG_PATH does not contain a production host configuration.');
  }
  const configured = Object.fromEntries(Object.entries(parsed.environment).filter(([, value]) => value !== undefined));
  if (Object.values(configured).some(value => typeof value !== 'string')) throw new TypeError('Production host configuration environment values must be strings.');
  const explicit = Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
  return Object.freeze({ ...explicit, ...configured });
}

export async function verifyProductionAdapterEnvironment(kind, environment = process.env, signal) {
  const configuration = productionAdapterConfiguration(kind, environment);
  const response = await invokeProductionHost({
    operation: 'identity', descriptor: configuration.descriptor, request: Object.freeze({ kind }), signal,
    command: configuration.command, args: configuration.args, timeoutMs: configuration.timeoutMs,
    maxOutputBytes: configuration.maxOutputBytes,
  });
  const result = validateHostResponse(response, 'identity', configuration.descriptor).result;
  if (result?.ready !== true || result?.kind !== kind) throw new Error(`Production ${kind} host identity result is invalid.`);
  if (kind === 'capability') {
    if (result.adapterRevisionSha256 !== configuration.descriptor.adapterRevisionSha256
      || result.evaluatorRevisionSha256 !== configuration.descriptor.evaluatorRevisionSha256) {
      throw new Error('Production capability host identity revisions differ from its descriptor.');
    }
  } else if (result.revisionSha256 !== configuration.descriptor.revisionSha256) {
    throw new Error(`Production ${kind} host identity revision differs from its descriptor.`);
  }
  return Object.freeze({ kind, descriptor: configuration.descriptor, identity: Object.freeze({ ...result }) });
}

export async function invokeProductionHost({ operation, descriptor, request, signal, command, args = [], timeoutMs = 120_000, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES }) {
  required(command, 'production adapter command');
  const input = Buffer.from(`${JSON.stringify(encodeProductionWireValue({ protocol: RIVE_PRODUCTION_ADAPTER_PROTOCOL, operation, descriptor, request }))}\n`);
  const stdout = await run(command, args, input, { signal, timeoutMs, maxOutputBytes });
  let response;
  try { response = decodeProductionWireValue(JSON.parse(stdout.toString('utf8'))); }
  catch (error) { throw new Error(`Production adapter host returned invalid JSON: ${bounded(error)}`, { cause: error }); }
  return response;
}

function run(command, args, input, { signal, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Production adapter request aborted.')); return; }
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const stdout = []; const stderr = []; let stdoutBytes = 0; let stderrBytes = 0; let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { child.kill(); finish(signal.reason ?? new Error('Production adapter request aborted.')); };
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { child.kill(); finish(new Error(`Production adapter host timed out after ${timeoutMs}ms.`)); }, timeoutMs);
    child.on('error', error => finish(error));
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxOutputBytes) { child.kill(); finish(new Error(`Production adapter stdout exceeded ${maxOutputBytes} bytes.`)); }
      else stdout.push(chunk);
    });
    child.stderr.on('data', chunk => { if (stderrBytes < 65_536) { stderr.push(chunk); stderrBytes += chunk.byteLength; } });
    child.on('close', code => {
      if (code !== 0) finish(new Error(`Production adapter host exited with ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 65_536)}`));
      else finish(null, Buffer.concat(stdout));
    });
    child.stdin.on('error', error => finish(error));
    child.stdin.end(input);
  });
}

function validateHostResponse(response, operation, descriptor) {
  if (response?.protocol !== RIVE_PRODUCTION_ADAPTER_PROTOCOL || response?.operation !== operation || response?.status !== 'completed') {
    throw new Error(`Production adapter host did not complete ${operation}: ${bounded(response?.error ?? 'invalid response envelope')}`);
  }
  if (stableJson(response.descriptor) !== stableJson(descriptor)) throw new Error('Production adapter host descriptor differs from the invoked revision.');
  if (!response.result || typeof response.result !== 'object') throw new TypeError('Production adapter host result is missing.');
  return response;
}

function validateCapabilityDescriptor(value) {
  const keys = ['adapterId', 'adapterRevisionSha256', 'evaluatorId', 'evaluatorRevisionSha256', 'optionsRevision'];
  exactKeys(value, keys, 'capability descriptor');
  for (const key of keys) required(value[key], `capability descriptor ${key}`);
  if (!HASH.test(value.adapterRevisionSha256) || !HASH.test(value.evaluatorRevisionSha256)) throw new TypeError('Capability descriptor revisions must be lowercase SHA-256.');
}

function validateCaptureDescriptor(value) {
  exactKeys(value, ['id', 'revisionSha256', 'runtime', 'backend', 'nativeBackend'], 'capture descriptor');
  for (const key of ['id', 'runtime', 'backend']) required(value[key], `capture descriptor ${key}`);
  if (!HASH.test(value.revisionSha256) || value.nativeBackend !== true) throw new TypeError('Capture descriptor must identify a revision-pinned native backend.');
}

export function encodeProductionWireValue(value, seen = new Set()) {
  if (value instanceof Uint8Array) return { $haiyueBytesBase64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  if (value instanceof Map) return { $haiyueMap: [...value].map(([key, item]) => [key, encodeProductionWireValue(item, seen)]) };
  if (Array.isArray(value)) return value.map(item => encodeProductionWireValue(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('Production adapter request contains a cycle.');
  seen.add(value);
  const output = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'signal').map(([key, item]) => [key, encodeProductionWireValue(item, seen)]));
  seen.delete(value);
  return output;
}

export function decodeProductionWireValue(value) {
  if (Array.isArray(value)) return value.map(decodeProductionWireValue);
  if (!value || typeof value !== 'object') return value;
  if (Object.keys(value).length === 1 && typeof value.$haiyueBytesBase64 === 'string') return Uint8Array.from(Buffer.from(value.$haiyueBytesBase64, 'base64'));
  if (Object.keys(value).length === 1 && Array.isArray(value.$haiyueMap)) return new Map(value.$haiyueMap.map(([key, item]) => [key, decodeProductionWireValue(item)]));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeProductionWireValue(item)]));
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || stableJson(Object.keys(value).sort()) !== stableJson([...keys].sort())) throw new TypeError(`${label} fields do not match the production protocol.`);
}
function parseJson(value, label) { required(value, label); try { return JSON.parse(value); } catch (error) { throw new TypeError(`${label} is not valid JSON: ${bounded(error)}`); } }
function positiveInteger(value, label) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${label} must be a positive integer.`); return number; }
function required(value, label) { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} is required.`); return value; }
function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function bounded(value) { return String(value instanceof Error ? value.message : value).replace(/[\r\n]+/gu, ' ').slice(0, 512); }
