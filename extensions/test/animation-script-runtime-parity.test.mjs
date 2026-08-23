import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capabilityTracePort,
  deferred,
  invocation,
  loadG09Modules,
  loopbackWorker,
  programFixture,
  runtimeLimits,
} from './animation-script-parity-fixture.mjs';

const { runtime } = await loadG09Modules();

test('portable VM arithmetic, context and seeded random replay byte-equivalently', async () => {
  const program = programFixture('converter', {
    id: 'math-converter', entrypoint: 'convert', registers: 6,
    constants: [2, 3],
    instructions: [
      { op: 'load-constant', to: 0, constant: 0 },
      { op: 'load-constant', to: 1, constant: 1 },
      { op: 'binary', to: 2, operator: 'add', left: 0, right: 1 },
      { op: 'load-context', to: 3, path: ['data', 'count'] },
      { op: 'random', to: 4 },
      { op: 'make-list', to: 5, values: [2, 3, 4] },
      { op: 'return', value: 5 },
    ],
  });
  const vm = new runtime.PortableScriptVm(program, runtimeLimits(), capabilityTracePort());
  const first = await vm.invoke(invocation(program.id, 'convert'), new AbortController().signal);
  const second = await vm.invoke(invocation(program.id, 'convert', { invocationId: 'math-converter-convert-2' }), new AbortController().signal);
  assert.deepEqual(first.value, second.value);
  assert.deepEqual(first.value.slice(0, 2), [5, 3]);
  assert.ok(first.value[2] >= 0 && first.value[2] < 1);
  assert.equal(first.stats.instructions, 7);
  assert.ok(first.stats.peakHeapBytes > 0);
});

test('node, layout, path, transition, listener and util protocols use bounded typed capabilities', async () => {
  const cases = [
    ['node', 'draw', 'canvas.emit'],
    ['layout', 'resize', 'canvas.emit'],
    ['path-effect', 'update', 'path.emit'],
    ['listener-action', 'perform', 'event.emit'],
  ];
  for (const [protocol, entrypoint, capability] of cases) {
    const program = programFixture(protocol, {
      id: `${protocol}-capability`, entrypoint, registers: 2, constants: ['command'], capabilities: [capability],
      instructions: [
        { op: 'load-constant', to: 0, constant: 0 },
        { op: 'load-context', to: 1, path: ['pointer', 'x'] },
        { op: 'capability', capability, arguments: [0, 1] },
        { op: 'return' },
      ],
    });
    const port = capabilityTracePort();
    const result = await new runtime.PortableScriptVm(program, runtimeLimits(), port)
      .invoke(invocation(program.id, entrypoint), new AbortController().signal);
    assert.equal(port.calls.length, 1);
    assert.equal(port.calls[0].capability, capability);
    assert.deepEqual(port.calls[0].arguments, ['command', 10]);
    assert.equal(result.stats.outputCommands, capability === 'event.emit' ? 0 : 1);
    assert.equal(result.stats.events, capability === 'event.emit' ? 1 : 0);
  }

  const transition = programFixture('transition-condition', {
    id: 'transition-evaluate', entrypoint: 'evaluate', registers: 1,
    instructions: [{ op: 'load-context', to: 0, path: ['focus', 'target'] }, { op: 'return', value: 0 }],
  });
  const transitionResult = await new runtime.PortableScriptVm(transition, runtimeLimits(), capabilityTracePort())
    .invoke(invocation(transition.id, 'evaluate'), new AbortController().signal);
  assert.equal(transitionResult.value, 'button');

  const util = programFixture('util', { id: 'util-call', entrypoint: 'add', registers: 1, constants: ['ok'], instructions: [{ op: 'load-constant', to: 0, constant: 0 }, { op: 'return', value: 0 }] });
  assert.equal((await new runtime.PortableScriptVm(util, runtimeLimits(), capabilityTracePort()).invoke(invocation(util.id, 'add'), new AbortController().signal)).value, 'ok');
});

test('instruction, heap, output, event and timer bombs fail with stable diagnostics', async () => {
  const loop = programFixture('util', { id: 'loop-bomb', entrypoint: 'add', instructions: [{ op: 'jump', target: 0 }] });
  await assert.rejects(
    new runtime.PortableScriptVm(loop, runtimeLimits({ maxInstructionsPerInvocation: 32 }), capabilityTracePort()).invoke(invocation(loop.id, 'add'), new AbortController().signal),
    error => error.code === 'E_SCRIPT_TIMEOUT',
  );

  const heap = programFixture('util', {
    id: 'heap-bomb', entrypoint: 'add', registers: 8,
    instructions: [{ op: 'make-list', to: 0, values: [1, 2, 3, 4, 5, 6, 7] }, { op: 'return', value: 0 }],
  });
  await assert.rejects(
    new runtime.PortableScriptVm(heap, runtimeLimits({ maxHeapBytes: 80 }), capabilityTracePort()).invoke(invocation(heap.id, 'add'), new AbortController().signal),
    error => error.code === 'E_SCRIPT_OOM',
  );

  const stringHeap = programFixture('util', {
    id: 'string-heap-bomb', entrypoint: 'add', registers: 1, constants: ['0123456789abcdef'],
    instructions: [
      { op: 'load-constant', to: 0, constant: 0 },
      { op: 'binary', to: 0, operator: 'concat', left: 0, right: 0 },
      { op: 'jump', target: 1 },
    ],
  });
  await assert.rejects(
    new runtime.PortableScriptVm(stringHeap, runtimeLimits({ maxHeapBytes: 256 }), capabilityTracePort()).invoke(invocation(stringHeap.id, 'add'), new AbortController().signal),
    error => error.code === 'E_SCRIPT_OOM',
  );

  for (const [capability, limitKey] of [['canvas.emit', 'maxOutputCommands'], ['event.emit', 'maxEventsPerInvocation'], ['timer.schedule', 'maxTimers']]) {
    const protocol = capability === 'canvas.emit' ? 'node' : 'listener-action';
    const entrypoint = capability === 'canvas.emit' ? 'draw' : 'perform';
    const program = programFixture(protocol, {
      id: `${capability}-bomb`, entrypoint, capabilities: [capability],
      instructions: [
        { op: 'capability', capability, arguments: [] },
        { op: 'capability', capability, arguments: [] },
        { op: 'return' },
      ],
    });
    await assert.rejects(
      new runtime.PortableScriptVm(program, runtimeLimits({ [limitKey]: 1 }), capabilityTracePort()).invoke(invocation(program.id, entrypoint), new AbortController().signal),
      error => error.code === 'E_SCRIPT_EVENT_BUDGET',
    );
  }
});

test('input snapshots are immutable and non-finite or prototype-shaped values never cross the port', async () => {
  const program = programFixture('util', {
    id: 'immutable-input', entrypoint: 'add', registers: 4, constants: ['value', 9],
    instructions: [
      { op: 'load-input', to: 0, name: 'table' },
      { op: 'load-constant', to: 1, constant: 0 },
      { op: 'load-constant', to: 2, constant: 1 },
      { op: 'set', target: 0, key: 1, value: 2 },
      { op: 'return' },
    ],
  });
  await assert.rejects(
    new runtime.PortableScriptVm(program, runtimeLimits(), capabilityTracePort()).invoke(invocation(program.id, 'add', { inputs: { table: { value: 1 } } }), new AbortController().signal),
    error => error.code === 'E_SCRIPT_CAPABILITY_DENIED',
  );
  const identity = programFixture('util', { id: 'identity', entrypoint: 'add', parameters: 1, registers: 1, instructions: [{ op: 'return', value: 0 }] });
  await assert.rejects(
    new runtime.PortableScriptVm(identity, runtimeLimits(), capabilityTracePort()).invoke(invocation(identity.id, 'add', { arguments: [Number.NaN] }), new AbortController().signal),
    error => error.code === 'E_SCRIPT_PROTOCOL',
  );
  const poisoned = JSON.parse('{"__proto__":{"polluted":true}}');
  await assert.rejects(
    new runtime.PortableScriptVm(identity, runtimeLimits(), capabilityTracePort()).invoke(invocation(identity.id, 'add', { arguments: [poisoned] }), new AbortController().signal),
    error => error.code === 'E_SCRIPT_PROTOCOL',
  );
  assert.equal({}.polluted, undefined);

  let accessorReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'secret', { enumerable: true, get() { accessorReads += 1; return globalThis; } });
  await assert.rejects(
    new runtime.PortableScriptVm(identity, runtimeLimits(), capabilityTracePort()).invoke(invocation(identity.id, 'add', { arguments: [accessor] }), new AbortController().signal),
    error => error.code === 'E_SCRIPT_PROTOCOL',
  );
  assert.equal(accessorReads, 0);

  await assert.rejects(
    new runtime.PortableScriptVm(identity, runtimeLimits(), capabilityTracePort()).invoke(invocation(identity.id, 'add', { arguments: [new (class HostObject {})()] }), new AbortController().signal),
    error => error.code === 'E_SCRIPT_PROTOCOL',
  );
});

test('worker owner validates handle tokens and preserves deterministic invocation order', async () => {
  const program = programFixture('converter', {
    id: 'handle-reader', entrypoint: 'convert', registers: 2, capabilities: ['data.read'],
    instructions: [
      { op: 'load-input', to: 0, name: 'handle' },
      { op: 'capability', to: 1, capability: 'data.read', arguments: [0] },
      { op: 'return', value: 1 },
    ],
  });
  const port = capabilityTracePort({ result: 42 });
  const workers = [];
  const owner = new runtime.ScriptSandboxOwner({
    workerFactory: () => { const worker = loopbackWorker(runtime); workers.push(worker); return worker; },
    programs: [program], limits: runtimeLimits(), capabilityPort: port,
    tokenFactory: (() => { let n = 0; return () => (++n).toString(16).padStart(64, '0'); })(),
  });
  const handle = owner.createHandle('view-model', 'score', ['read']);
  const first = owner.invoke(invocation(program.id, 'convert', { invocationId: 'ordered-1', inputs: { handle } }));
  const second = owner.invoke(invocation(program.id, 'convert', { invocationId: 'ordered-2', inputs: { handle } }));
  assert.equal((await first).value, 42);
  assert.equal((await second).value, 42);
  assert.deepEqual(port.calls.map(call => call.invocationId), ['ordered-1', 'ordered-2']);

  const forged = { ...handle, token: 'f'.repeat(64) };
  await assert.rejects(owner.invoke(invocation(program.id, 'convert', { invocationId: 'forged', inputs: { handle: forged } })), error => error.code === 'E_SCRIPT_CAPABILITY_DENIED');
  await assert.rejects(owner.invoke(invocation(program.id, 'convert', { invocationId: 'primitive-target', inputs: { handle: 'score' } })), error => error.code === 'E_SCRIPT_CAPABILITY_DENIED');
  await owner.dispose();
  assert.equal(workers.every(worker => worker.terminated), true);
  assert.deepEqual(owner.stats(), { generation: 2, handles: 0, pending: 0, worker: 0, scopeInstructions: 10, crashed: false, disposed: true });
});

test('capability results remain plain portable data without invoking host accessors', async () => {
  const program = programFixture('converter', {
    id: 'host-result-reader', entrypoint: 'convert', registers: 2, capabilities: ['data.read'],
    instructions: [
      { op: 'load-input', to: 0, name: 'handle' },
      { op: 'capability', to: 1, capability: 'data.read', arguments: [0] },
      { op: 'return', value: 1 },
    ],
  });
  let accessorReads = 0;
  const result = {};
  Object.defineProperty(result, 'secret', { enumerable: true, get() { accessorReads += 1; return globalThis; } });
  const owner = new runtime.ScriptSandboxOwner({
    workerFactory: () => loopbackWorker(runtime), programs: [program], limits: runtimeLimits(),
    capabilityPort: capabilityTracePort({ result }),
  });
  const handle = owner.createHandle('view-model', 'host-result', ['read']);
  await assert.rejects(owner.invoke(invocation(program.id, 'convert', { inputs: { handle } })), error => error.code === 'E_SCRIPT_CAPABILITY_DENIED');
  assert.equal(accessorReads, 0);
  await owner.dispose();
});

test('replace, abort, crash/restart and dispose invalidate every late promise and generation', async () => {
  const program = programFixture('converter', {
    id: 'async-reader', entrypoint: 'convert', registers: 2, capabilities: ['data.read'],
    instructions: [
      { op: 'load-input', to: 0, name: 'handle' },
      { op: 'capability', to: 1, capability: 'data.read', arguments: [0] },
      { op: 'return', value: 1 },
    ],
  });
  const gate = deferred();
  const port = capabilityTracePort({ gate: () => gate.promise });
  const workers = [];
  const owner = new runtime.ScriptSandboxOwner({
    workerFactory: () => { const worker = loopbackWorker(runtime); workers.push(worker); return worker; },
    programs: [program], limits: runtimeLimits({ maxWallTimeMs: 1_000 }), capabilityPort: port,
  });
  const handle = owner.createHandle('view-model', 'late-value', ['read']);
  const pending = owner.invoke(invocation(program.id, 'convert', { invocationId: 'late', inputs: { handle } }));
  await waitFor(() => port.calls.length === 1);
  await owner.replacePrograms([program]);
  await assert.rejects(pending, error => error.code === 'E_SCRIPT_ABORTED');
  gate.resolve(7);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(owner.stats().pending, 0);

  const successPort = capabilityTracePort({ result: 9 });
  const restartOwner = new runtime.ScriptSandboxOwner({
    workerFactory: () => { const worker = loopbackWorker(runtime); workers.push(worker); return worker; },
    programs: [program], limits: runtimeLimits(), capabilityPort: successPort,
  });
  const restartHandle = restartOwner.createHandle('view-model', 'restart-value', ['read']);
  assert.equal((await restartOwner.invoke(invocation(program.id, 'convert', { invocationId: 'before-crash', inputs: { handle: restartHandle } }))).value, 9);
  workers.at(-1).crash();
  await waitFor(() => restartOwner.stats().worker === 0);
  assert.equal((await restartOwner.invoke(invocation(program.id, 'convert', { invocationId: 'after-crash', inputs: { handle: restartHandle } }))).value, 9);
  assert.equal(workers.length >= 3, true);
  await restartOwner.dispose();
  await restartOwner.dispose();
  assert.equal(restartOwner.stats().pending, 0);
  assert.equal(restartOwner.stats().worker, 0);
  await owner.dispose();
});

test('external abort rejects once and late capability completion cannot write back', async () => {
  const program = programFixture('converter', {
    id: 'abort-reader', entrypoint: 'convert', registers: 2, capabilities: ['data.read'],
    instructions: [
      { op: 'load-input', to: 0, name: 'handle' },
      { op: 'capability', to: 1, capability: 'data.read', arguments: [0] },
      { op: 'return', value: 1 },
    ],
  });
  const gate = deferred(); const port = capabilityTracePort({ gate: () => gate.promise });
  const owner = new runtime.ScriptSandboxOwner({ workerFactory: () => loopbackWorker(runtime), programs: [program], limits: runtimeLimits({ maxWallTimeMs: 1_000 }), capabilityPort: port });
  const handle = owner.createHandle('view-model', 'abort-value', ['read']);
  const controller = new AbortController();
  const pending = owner.invoke(invocation(program.id, 'convert', { inputs: { handle } }), controller.signal);
  await waitFor(() => port.calls.length === 1);
  controller.abort();
  await assert.rejects(pending, error => error.code === 'E_SCRIPT_ABORTED');
  gate.resolve(5);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(owner.stats().pending, 0);
  await owner.dispose();
});

test('sandbox scope budget covers successful and failed invocations before another tick can start', async () => {
  const program = programFixture('util', { id: 'scope-success', entrypoint: 'add', instructions: [{ op: 'return' }] });
  const failed = programFixture('util', { id: 'scope-failure', entrypoint: 'add', instructions: [{ op: 'jump', target: 0 }] });
  const owner = new runtime.ScriptSandboxOwner({
    workerFactory: () => loopbackWorker(runtime),
    programs: [program, failed],
    limits: runtimeLimits({ maxInstructionsPerInvocation: 2, maxInstructionsPerScope: 4 }),
    capabilityPort: capabilityTracePort(),
  });
  await assert.rejects(owner.invoke(invocation(failed.id, 'add', { invocationId: 'scope-failed' })), error => error.code === 'E_SCRIPT_TIMEOUT');
  await owner.invoke(invocation(program.id, 'add', { invocationId: 'scope-1' }));
  await owner.invoke(invocation(program.id, 'add', { invocationId: 'scope-2' }));
  await assert.rejects(owner.invoke(invocation(program.id, 'add', { invocationId: 'scope-3' })), error => error.code === 'E_SCRIPT_TIMEOUT');
  assert.equal(owner.stats().scopeInstructions, 4);
  await owner.dispose();
});

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for test condition');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
