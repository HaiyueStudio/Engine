export const SOURCE_REVISION_SHA256 = 'b99f06310ba0e09c3402dd2be37d8447dd63ee980e7d42dd7396e26117cea661';

export const SCRIPT_LIMITS = Object.freeze({
  maxPrograms: 128,
  maxProgramBytes: 1_048_576,
  maxFunctions: 512,
  maxInstructionsPerFunction: 16_384,
  maxInstructionsPerInvocation: 1_000_000,
  maxInstructionsPerScope: 10_000_000,
  maxRegistersPerFunction: 512,
  maxConstants: 8_192,
  maxStringBytes: 4_194_304,
  maxHeapBytes: 16_777_216,
  maxCallDepth: 128,
  maxOutputCommands: 4_096,
  maxEventsPerInvocation: 64,
  maxTimers: 256,
  maxPendingPromises: 64,
  maxWallTimeMs: 50,
  maxShaderModules: 32,
  maxShaderSourceBytes: 262_144,
  maxShaderTokens: 65_536,
  maxShaderBindings: 32,
  maxTextures: 16,
  maxUniformBytes: 65_536,
  maxStorageBytes: 67_108_864,
  maxPipelines: 32,
  maxDrawsPerFrame: 256,
});

const documentedEntrypoints = {
  node: ['init', 'advance', 'update', 'draw'],
  layout: ['init', 'advance', 'update', 'draw', 'measure', 'resize'],
  converter: ['init', 'convert', 'reverseConvert'],
  'path-effect': ['init', 'update', 'advance'],
  'transition-condition': ['init', 'evaluate'],
  'listener-action': ['init', 'perform'],
  util: ['add'],
};

export function programFixture(protocol, options = {}) {
  const id = options.id ?? `${protocol}-program`;
  const entrypoints = {};
  const functions = [];
  for (const name of documentedEntrypoints[protocol]) {
    const functionId = `${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}-fn`;
    entrypoints[name] = functionId;
    functions.push({
      id: functionId,
      parameters: name === (options.entrypoint ?? documentedEntrypoints[protocol][0]) ? (options.parameters ?? 0) : 0,
      registers: name === (options.entrypoint ?? documentedEntrypoints[protocol][0]) ? (options.registers ?? 1) : 1,
      instructions: name === (options.entrypoint ?? documentedEntrypoints[protocol][0])
        ? (options.instructions ?? [{ op: 'return' }])
        : [{ op: 'return' }],
    });
  }
  return {
    id,
    protocol,
    artifact: 'haiyue-portable-script@1',
    sourceRevisionSha256: SOURCE_REVISION_SHA256,
    constants: options.constants ?? [],
    functions,
    entrypoints,
    capabilities: options.capabilities ?? [],
  };
}
export function scriptDocumentFixture() {
  const protocols = ['node', 'layout', 'converter', 'path-effect', 'transition-condition', 'listener-action', 'util'];
  return {
    extension: 'org.haiyue.sandboxed-animation-script@1',
    version: 1,
    language: {
      source: 'luau',
      sourcePolicy: 'build-time-only',
      sourceRevisionSha256: SOURCE_REVISION_SHA256,
      artifact: 'haiyue-portable-script@1',
      numericMode: 'ieee754-f64-canonical-nan',
      stringMode: 'utf8',
      tableMode: 'insertion-ordered-own-keys',
      modulePolicy: 'closed-manifest',
      clock: 'injected-integer-microseconds',
      random: 'injected-seeded-xoshiro128',
    },
    limits: { ...SCRIPT_LIMITS },
    programs: protocols.map(protocol => programFixture(protocol)),
    shaders: [shaderFixture()],
  };
}

export function shaderFixture(overrides = {}) {
  return {
    id: 'tint-fragment',
    language: 'wgsl',
    vertexEntryPoint: 'vertexMain',
    fragmentEntryPoint: 'fragmentMain',
    source: `
struct Params { color: vec4<f32> }
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var output: VertexOutput;
  output.position = vec4(positions[index], 0.0, 1.0);
  output.uv = output.position.xy * vec2(0.5, -0.5) + vec2(0.5);
  return output;
}
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  return params.color * vec4<f32>(input.uv, 1.0, 1.0);
}`,
    bindings: [{ binding: 0, kind: 'uniform-buffer', visibility: 'fragment', maxBytes: 16 }],
    targetFormat: 'rgba8unorm',
    ...overrides,
  };
}

export function runtimeLimits(overrides = {}) {
  return {
    maxInstructionsPerInvocation: SCRIPT_LIMITS.maxInstructionsPerInvocation,
    maxInstructionsPerScope: SCRIPT_LIMITS.maxInstructionsPerScope,
    maxHeapBytes: SCRIPT_LIMITS.maxHeapBytes,
    maxCallDepth: SCRIPT_LIMITS.maxCallDepth,
    maxOutputCommands: SCRIPT_LIMITS.maxOutputCommands,
    maxEventsPerInvocation: SCRIPT_LIMITS.maxEventsPerInvocation,
    maxTimers: SCRIPT_LIMITS.maxTimers,
    maxPendingPromises: SCRIPT_LIMITS.maxPendingPromises,
    maxWallTimeMs: SCRIPT_LIMITS.maxWallTimeMs,
    maxShaderSourceBytes: SCRIPT_LIMITS.maxShaderSourceBytes,
    maxShaderTokens: SCRIPT_LIMITS.maxShaderTokens,
    maxShaderBindings: SCRIPT_LIMITS.maxShaderBindings,
    maxTextures: SCRIPT_LIMITS.maxTextures,
    maxUniformBytes: SCRIPT_LIMITS.maxUniformBytes,
    maxStorageBytes: SCRIPT_LIMITS.maxStorageBytes,
    maxPipelines: SCRIPT_LIMITS.maxPipelines,
    maxDrawsPerFrame: SCRIPT_LIMITS.maxDrawsPerFrame,
    ...overrides,
  };
}

export function invocation(programId, entrypoint, overrides = {}) {
  return {
    invocationId: overrides.invocationId ?? `${programId}-${entrypoint}-1`,
    programId,
    entrypoint,
    arguments: overrides.arguments ?? [],
    inputs: overrides.inputs ?? {},
    context: overrides.context ?? {
      clockMicros: 1_000_000,
      seed: [1, 2, 3, 4],
      pointer: { x: 10, y: 20, phase: 'move' },
      keyboard: { key: 'Enter', repeat: false },
      gamepad: { index: 0, button: 1 },
      focus: { target: 'button' },
      data: { count: 3 },
    },
  };
}

export function capabilityTracePort(options = {}) {
  const calls = [];
  const scopes = [];
  return {
    calls,
    scopes,
    invoke(request, signal) {
      calls.push(structuredClone(request));
      if (options.gate) return options.gate(request, signal);
      return options.result ?? null;
    },
    disposeScope(generation) { scopes.push(generation); },
  };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function loopbackWorker(runtime) {
  const hostMessage = new Set(); const hostError = new Set(); const hostMessageError = new Set(); const workerMessage = new Set();
  let terminated = false;
  const workerEndpoint = {
    postMessage(message) { if (!terminated) queueMicrotask(() => { for (const listener of hostMessage) listener({ data: structuredClone(message) }); }); },
    addEventListener(type, listener) { if (type === 'message') workerMessage.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') workerMessage.delete(listener); },
  };
  const uninstall = runtime.installAnimationScriptWorkerRuntime(workerEndpoint);
  return {
    get terminated() { return terminated; },
    postMessage(message) { if (!terminated) queueMicrotask(() => { for (const listener of workerMessage) listener({ data: structuredClone(message) }); }); },
    addEventListener(type, listener) { (type === 'message' ? hostMessage : type === 'error' ? hostError : hostMessageError).add(listener); },
    removeEventListener(type, listener) { (type === 'message' ? hostMessage : type === 'error' ? hostError : hostMessageError).delete(listener); },
    terminate() { if (terminated) return; terminated = true; uninstall(); hostMessage.clear(); workerMessage.clear(); },
    crash(message = 'worker crash') { for (const listener of hostError) listener({ message }); },
    messageError() { for (const listener of hostMessageError) listener({}); },
  };
}

export async function loadG09Modules() {
  const [specRoot, runtimeRoot] = await Promise.all([
    transpileRoot('script-spec', new URL('../../animation-spec/src/script/', import.meta.url)),
    transpileRoot('script-runtime', new URL('../src/animation-script/', import.meta.url)),
  ]);
  const [script, runtime] = await Promise.all([
    import(new URL('script-spec/index.js', specRoot).href),
    import(new URL('script-runtime/index.js', runtimeRoot).href),
  ]);
  return { script, runtime };
}

async function transpileRoot(name, sourceUrl) {
  const { mkdtemp, mkdir, readFile, readdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ts = await import('typescript');
  const temporary = await mkdtemp(path.join(tmpdir(), 'haiyue-g09-'));
  const sourceRoot = fileURLToPath(sourceUrl);
  for (const file of (await walk(sourceRoot, readdir, path)).filter(file => file.endsWith('.ts'))) {
    const output = path.join(temporary, name, path.relative(sourceRoot, file).replace(/\.ts$/, '.js'));
    await mkdir(path.dirname(output), { recursive: true });
    const compiled = ts.transpileModule(await readFile(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText;
    await writeFile(output, compiled);
  }
  return new URL(`file:///${temporary.replaceAll('\\', '/')}/`);
}

async function walk(directory, readdir, path) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(resolved, readdir, path));
    else result.push(resolved);
  }
  return result;
}
