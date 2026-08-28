import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createProductionCapabilityEvaluator,
  createProductionCaptureAdapter,
  decodeProductionWireValue,
  encodeProductionWireValue,
  invokeProductionHost,
  productionAdapterFromEnvironment,
  verifyProductionAdapterEnvironment,
} from './rive-production-adapter-bridge.mjs';

test('production wire preserves explicit undefined fields required by exact-key contracts', () => {
  const input = { capability: 'hya-core', artifactId: undefined };
  const roundTrip = decodeProductionWireValue(JSON.parse(JSON.stringify(encodeProductionWireValue(input))));
  assert.deepEqual(Object.keys(roundTrip).sort(), ['artifactId', 'capability']);
  assert.equal(roundTrip.artifactId, undefined);
});

const root = dirname(fileURLToPath(import.meta.url));

const capabilityDescriptor = Object.freeze({
  adapterId: 'haiyue-rive-native-adapter',
  adapterRevisionSha256: '1'.repeat(64),
  evaluatorId: 'haiyue-rive-native-evaluator',
  evaluatorRevisionSha256: '2'.repeat(64),
  optionsRevision: 'rive-7.3-production-v1',
});
const captureDescriptor = Object.freeze({
  id: 'official-native-capture', revisionSha256: '3'.repeat(64),
  runtime: '@rive-app/webgl2@2.40.0', backend: 'webgl2', nativeBackend: true,
});

test('production capability bridge binds the host response to the invoked revision', async () => {
  const expected = { format: 'haiyue-rive-neutral-capability-evaluation' };
  const evaluator = createProductionCapabilityEvaluator({
    descriptor: capabilityDescriptor,
    invoke: async request => ({
      protocol: 'haiyue-rive-production-adapter@1', operation: request.operation,
      status: 'completed', descriptor: capabilityDescriptor, result: expected,
    }),
  });
  assert.equal(await evaluator.evaluate({}, new AbortController().signal), expected);
});

test('production capture bridge owns artifact bytes and rejects duplicate paths', async () => {
  const invoke = async request => ({
    protocol: 'haiyue-rive-production-adapter@1', operation: request.operation,
    status: 'completed', descriptor: captureDescriptor,
    result: { artifactBytesByPath: [['capture.rgba', new Uint8Array([1, 2, 3, 4])]], channels: {} },
  });
  const adapter = createProductionCaptureAdapter({ descriptor: captureDescriptor, invoke });
  const capture = await adapter.capture({ signal: new AbortController().signal });
  assert.deepEqual([...capture.artifactBytesByPath.get('capture.rgba')], [1, 2, 3, 4]);
  assert.ok(capture.artifactBytesByPath instanceof Map);
});

test('subprocess production protocol preserves binary request and response values', async () => {
  const host = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const value=JSON.parse(input);process.stdout.write(JSON.stringify({protocol:value.protocol,operation:value.operation,status:'completed',descriptor:value.descriptor,result:{echo:value.request.bytes}}));});`;
  const response = await invokeProductionHost({
    operation: 'capability-evaluation', descriptor: capabilityDescriptor,
    request: { bytes: new Uint8Array([5, 6, 7]) }, command: process.execPath, args: ['-e', host],
    timeoutMs: 10_000, maxOutputBytes: 1_048_576,
  });
  assert.deepEqual([...response.result.echo], [5, 6, 7]);
});

test('production bridge rejects a host that changes its descriptor identity', async () => {
  const adapter = createProductionCaptureAdapter({
    descriptor: captureDescriptor,
    invoke: async request => ({
      protocol: 'haiyue-rive-production-adapter@1', operation: request.operation,
      status: 'completed', descriptor: { ...captureDescriptor, revisionSha256: '4'.repeat(64) },
      result: { artifactBytesByPath: [], channels: {} },
    }),
  });
  await assert.rejects(adapter.capture({}), /descriptor differs/u);
});

test('repository production gateway preflights immutable provider bytes and executes capability requests', async t => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'rive-production-provider-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const providerPath = resolve(temporary, 'provider.mjs');
  writeFileSync(providerPath, "console.log('provider loaded'); export async function evaluate(request) { return { echo: request.bytes }; }\n");
  const gatewayPath = resolve(root, 'rive-production-host.mjs');
  const descriptor = {
    adapterId: 'haiyue-rive-production-host', adapterRevisionSha256: hash(readFileSync(gatewayPath)),
    evaluatorId: 'fixture-capability-provider', evaluatorRevisionSha256: hash(readFileSync(providerPath)),
    optionsRevision: 'rive-7.3-production-v1',
  };
  const environment = {
    RIVE_CAPABILITY_EVALUATOR_COMMAND: process.execPath,
    RIVE_CAPABILITY_EVALUATOR_ARGS_JSON: JSON.stringify([gatewayPath, '--kind=capability', `--provider=${providerPath}`]),
    RIVE_CAPABILITY_EVALUATOR_DESCRIPTOR_JSON: JSON.stringify(descriptor),
  };
  const identity = await verifyProductionAdapterEnvironment('capability', environment);
  assert.equal(identity.identity.ready, true);
  assert.equal(identity.identity.evaluatorRevisionSha256, descriptor.evaluatorRevisionSha256);
  const evaluator = productionAdapterFromEnvironment('capability', environment);
  const result = await evaluator.evaluate({ bytes: new Uint8Array([9, 8, 7]) }, new AbortController().signal);
  assert.deepEqual([...result.echo], [9, 8, 7]);

  const changed = { ...environment, RIVE_CAPABILITY_EVALUATOR_DESCRIPTOR_JSON: JSON.stringify({ ...descriptor, evaluatorRevisionSha256: 'f'.repeat(64) }) };
  await assert.rejects(verifyProductionAdapterEnvironment('capability', changed), /exited with 1.*provider bytes/us);
});

test('repository production gateway preserves capture artifacts and attests the requested browser environment', async t => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'rive-production-capture-provider-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const providerPath = resolve(temporary, 'provider.mjs');
  writeFileSync(providerPath, `export async function capture(request) {
    return { environment: request.environment, channels: {}, artifactBytesByPath: new Map([['capture.rgba', new Uint8Array([1, 2, 3, 4])]]) };
  }\n`);
  const gatewayPath = resolve(root, 'rive-production-host.mjs');
  const descriptor = {
    id: 'fixture-official-capture', revisionSha256: hash(readFileSync(providerPath)),
    runtime: '@rive-app/webgl2@2.40.0', backend: 'webgl2', nativeBackend: true,
  };
  const environment = {
    RIVE_OFFICIAL_CAPTURE_COMMAND: process.execPath,
    RIVE_OFFICIAL_CAPTURE_ARGS_JSON: JSON.stringify([gatewayPath, '--kind=official', `--provider=${providerPath}`]),
    RIVE_OFFICIAL_CAPTURE_DESCRIPTOR_JSON: JSON.stringify(descriptor),
  };
  const adapter = productionAdapterFromEnvironment('official', environment);
  const browserEnvironment = { browser: 'chrome', browserVersion: '151.0.0.0', os: 'Windows 11' };
  const capture = await adapter.capture({ environment: browserEnvironment });
  assert.deepEqual(capture.environment, browserEnvironment);
  assert.deepEqual([...capture.artifactBytesByPath.get('capture.rgba')], [1, 2, 3, 4]);
});

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
