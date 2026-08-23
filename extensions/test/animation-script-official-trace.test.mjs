import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capabilityTracePort,
  invocation,
  loadG09Modules,
  programFixture,
  runtimeLimits,
  scriptDocumentFixture,
} from './animation-script-parity-fixture.mjs';

const { script, runtime } = await loadG09Modules();

const OFFICIAL_PROTOCOL_TRACE = Object.freeze({
  evidenceClass: 'candidate-documentation-trace',
  retrievedAt: '2026-08-23',
  sourceRevision: 'luigi-rosso/luau@rive_0_733',
  protocols: Object.freeze([
    Object.freeze({ protocol: 'node', source: 'https://rive.app/docs/scripting/protocols/node-scripts', entrypoints: ['init', 'advance', 'update', 'draw'], required: [] }),
    Object.freeze({ protocol: 'layout', source: 'https://rive.app/docs/scripting/protocols/layout-scripts', entrypoints: ['init', 'advance', 'update', 'draw', 'measure', 'resize'], required: ['resize'] }),
    Object.freeze({ protocol: 'converter', source: 'https://rive.app/docs/scripting/protocols/converter-scripts', entrypoints: ['init', 'convert', 'reverseConvert'], required: ['convert'] }),
    Object.freeze({ protocol: 'path-effect', source: 'https://rive.app/docs/scripting/protocols/path-effect-scripts', entrypoints: ['init', 'update', 'advance'], required: ['update'] }),
    Object.freeze({ protocol: 'transition-condition', source: 'https://rive.app/docs/scripting/protocols/transition-condition-scripts', entrypoints: ['init', 'evaluate'], required: ['init', 'evaluate'] }),
    Object.freeze({ protocol: 'listener-action', source: 'https://rive.app/docs/scripting/protocols/listener-action-scripts', entrypoints: ['init', 'perform'], required: ['init', 'perform'] }),
    Object.freeze({ protocol: 'util', source: 'https://rive.app/docs/scripting/protocols/util-scripts', entrypoints: ['add'], required: [] }),
  ]),
});

test('candidate official protocol trace freezes documented lifecycle names and required methods', () => {
  assert.equal(OFFICIAL_PROTOCOL_TRACE.evidenceClass, 'candidate-documentation-trace');
  assert.ok(OFFICIAL_PROTOCOL_TRACE.protocols.every(entry => entry.source.startsWith('https://rive.app/docs/scripting/')));
  const document = scriptDocumentFixture();
  const parsed = script.parseSandboxedAnimationScriptDocument(document);
  for (const trace of OFFICIAL_PROTOCOL_TRACE.protocols) {
    const program = parsed.programs.find(entry => entry.protocol === trace.protocol);
    assert.deepEqual(Object.keys(program.entrypoints), trace.entrypoints, trace.protocol);
    for (const required of trace.required) {
      const missing = scriptDocumentFixture();
      delete missing.programs.find(entry => entry.protocol === trace.protocol).entrypoints[required];
      assert.throws(
        () => script.parseSandboxedAnimationScriptDocument(missing),
        error => error.code === 'E_ANIMATION_SCRIPT_PROTOCOL' && error.path.endsWith(`.${required}`),
        `${trace.protocol}.${required}`,
      );
    }
  }
  const legacy = scriptDocumentFixture();
  const pathEffect = legacy.programs.find(entry => entry.protocol === 'path-effect');
  pathEffect.entrypoints.apply = pathEffect.entrypoints.update;
  assert.throws(() => script.parseSandboxedAnimationScriptDocument(legacy), error => error.code === 'E_ANIMATION_SCRIPT_PROTOCOL');
});

test('candidate official protocol trace dispatches every documented entrypoint through the neutral VM', async () => {
  const actual = [];
  for (const trace of OFFICIAL_PROTOCOL_TRACE.protocols) {
    const program = programFixture(trace.protocol, { id: `${trace.protocol}-trace` });
    const vm = new runtime.PortableScriptVm(program, runtimeLimits(), capabilityTracePort());
    for (const entrypoint of trace.entrypoints) {
      const result = await vm.invoke(invocation(program.id, entrypoint, { invocationId: `${program.id}-${entrypoint}` }), new AbortController().signal);
      actual.push(`${trace.protocol}:${entrypoint}:${result.stats.instructions}`);
    }
  }
  assert.deepEqual(actual, OFFICIAL_PROTOCOL_TRACE.protocols.flatMap(trace => trace.entrypoints.map(entrypoint => `${trace.protocol}:${entrypoint}:1`)));
});
