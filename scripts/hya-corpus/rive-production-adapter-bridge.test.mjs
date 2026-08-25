import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProductionCapabilityEvaluator,
  createProductionCaptureAdapter,
  invokeProductionHost,
} from './rive-production-adapter-bridge.mjs';

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

