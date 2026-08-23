import { scriptFormatError } from './diagnostics.js';
import { resolveSandboxedAnimationScriptLimits, type SandboxedAnimationScriptLimitOverrides } from './limits.js';
import {
  PORTABLE_SCRIPT_ARTIFACT,
  SANDBOXED_ANIMATION_SCRIPT_EXTENSION,
  type AnimationScriptCapability,
  type AnimationScriptProtocol,
  type AnimationScriptSourceLocation,
  type PortableScriptConstant,
  type PortableScriptFunction,
  type PortableScriptInstruction,
  type PortableScriptProgram,
  type SandboxedAnimationScriptDocument,
  type SandboxedAnimationScriptLimits,
  type SandboxedShaderBinding,
  type SandboxedShaderModule,
} from './types.js';

const SOURCE_REVISION_SHA256 = 'b99f06310ba0e09c3402dd2be37d8447dd63ee980e7d42dd7396e26117cea661';
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PROTOCOLS = new Set<AnimationScriptProtocol>([
  'node', 'layout', 'converter', 'path-effect', 'transition-condition', 'listener-action', 'util',
]);
const CAPABILITIES = new Set<AnimationScriptCapability>([
  'data.read', 'data.write', 'asset.read', 'path.emit', 'canvas.emit', 'event.emit', 'timer.schedule', 'timer.cancel',
]);
const PROTOCOL_CAPABILITIES: Readonly<Record<AnimationScriptProtocol, ReadonlySet<AnimationScriptCapability>>> = Object.freeze({
  node: new Set<AnimationScriptCapability>(['data.read', 'data.write', 'asset.read', 'canvas.emit', 'event.emit', 'timer.schedule', 'timer.cancel']),
  layout: new Set<AnimationScriptCapability>(['data.read', 'data.write', 'asset.read', 'canvas.emit']),
  converter: new Set<AnimationScriptCapability>(['data.read', 'asset.read']),
  'path-effect': new Set<AnimationScriptCapability>(['data.read', 'asset.read', 'path.emit']),
  'transition-condition': new Set<AnimationScriptCapability>(['data.read']),
  'listener-action': new Set<AnimationScriptCapability>(['data.read', 'data.write', 'asset.read', 'event.emit', 'timer.schedule', 'timer.cancel']),
  util: new Set<AnimationScriptCapability>(['data.read', 'asset.read']),
});
const PROTOCOL_ENTRYPOINTS: Readonly<Record<AnimationScriptProtocol, ReadonlySet<string> | undefined>> = Object.freeze({
  node: new Set(['init', 'advance', 'update', 'draw']),
  layout: new Set(['init', 'advance', 'update', 'draw', 'measure', 'resize']),
  converter: new Set(['init', 'convert', 'reverseConvert']),
  'path-effect': new Set(['init', 'update', 'advance']),
  'transition-condition': new Set(['init', 'evaluate']),
  'listener-action': new Set(['init', 'perform']),
  // Utility scripts export a user-defined module table, so their public names are intentionally open.
  util: undefined,
});
const REQUIRED_ENTRYPOINTS: Readonly<Record<AnimationScriptProtocol, readonly string[]>> = Object.freeze({
  node: Object.freeze([]),
  layout: Object.freeze(['resize']),
  converter: Object.freeze(['convert']),
  'path-effect': Object.freeze(['update']),
  'transition-condition': Object.freeze(['init', 'evaluate']),
  'listener-action': Object.freeze(['init', 'perform']),
  util: Object.freeze([]),
});
const LIMIT_KEYS = Object.freeze([
  'maxPrograms', 'maxProgramBytes', 'maxFunctions', 'maxInstructionsPerFunction', 'maxInstructionsPerInvocation',
  'maxInstructionsPerScope',
  'maxRegistersPerFunction', 'maxConstants', 'maxStringBytes', 'maxHeapBytes', 'maxCallDepth',
  'maxOutputCommands', 'maxEventsPerInvocation', 'maxTimers', 'maxPendingPromises', 'maxWallTimeMs',
  'maxShaderModules', 'maxShaderSourceBytes', 'maxShaderTokens', 'maxShaderBindings', 'maxUniformBytes',
  'maxTextures', 'maxStorageBytes', 'maxPipelines', 'maxDrawsPerFrame',
] as const);

export interface ParseSandboxedAnimationScriptOptions {
  readonly limits?: SandboxedAnimationScriptLimitOverrides;
}

export function parseSandboxedAnimationScriptDocument(
  input: unknown,
  options: ParseSandboxedAnimationScriptOptions = {},
): SandboxedAnimationScriptDocument {
  assertPlainDataGraph(input, '$', new Set(), new Set());
  const root = object(input, '$');
  exact(root, '$', ['extension', 'version', 'language', 'limits', 'programs', 'shaders']);
  literal(root.extension, SANDBOXED_ANIMATION_SCRIPT_EXTENSION, '$.extension', 'E_ANIMATION_SCRIPT_FORMAT');
  literal(root.version, 1, '$.version', 'E_ANIMATION_SCRIPT_VERSION');
  const hard = resolveSandboxedAnimationScriptLimits(options.limits);
  const limits = parseLimits(root.limits, '$.limits', hard);
  const language = parseLanguage(root.language, '$.language');
  const programsInput = array(root.programs, '$.programs');
  if (programsInput.length > limits.maxPrograms) limit('$.programs', `Program count ${programsInput.length} exceeds ${limits.maxPrograms}.`);
  const programs = programsInput.map((value, index) => parseProgram(value, `$.programs[${index}]`, limits, language.sourceRevisionSha256));
  unique(programs.map(program => program.id), '$.programs');
  const shadersInput = array(root.shaders, '$.shaders');
  if (shadersInput.length > limits.maxShaderModules) limit('$.shaders', `Shader count ${shadersInput.length} exceeds ${limits.maxShaderModules}.`);
  const shaders = shadersInput.map((value, index) => parseShader(value, `$.shaders[${index}]`, limits));
  unique(shaders.map(shader => shader.id), '$.shaders');
  return deepFreeze({
    extension: SANDBOXED_ANIMATION_SCRIPT_EXTENSION,
    version: 1 as const,
    language,
    limits,
    programs,
    shaders,
  });
}

function parseLanguage(input: unknown, path: string): SandboxedAnimationScriptDocument['language'] {
  const value = object(input, path);
  exact(value, path, [
    'source', 'sourcePolicy', 'sourceRevisionSha256', 'artifact', 'numericMode', 'stringMode',
    'tableMode', 'modulePolicy', 'clock', 'random',
  ]);
  literal(value.source, 'luau', `${path}.source`, 'E_ANIMATION_SCRIPT_PROTOCOL');
  literal(value.sourcePolicy, 'build-time-only', `${path}.sourcePolicy`, 'E_ANIMATION_SCRIPT_PROTOCOL');
  const revision = string(value.sourceRevisionSha256, `${path}.sourceRevisionSha256`, 64);
  if (!SHA256.test(revision) || revision !== SOURCE_REVISION_SHA256) {
    scriptFormatError('E_ANIMATION_SCRIPT_PROTOCOL', `${path}.sourceRevisionSha256`, 'Source runtime revision is not the frozen revision.');
  }
  literal(value.artifact, PORTABLE_SCRIPT_ARTIFACT, `${path}.artifact`, 'E_ANIMATION_SCRIPT_ARTIFACT');
  literal(value.numericMode, 'ieee754-f64-canonical-nan', `${path}.numericMode`, 'E_ANIMATION_SCRIPT_PROTOCOL');
  literal(value.stringMode, 'utf8', `${path}.stringMode`, 'E_ANIMATION_SCRIPT_PROTOCOL');
  literal(value.tableMode, 'insertion-ordered-own-keys', `${path}.tableMode`, 'E_ANIMATION_SCRIPT_PROTOCOL');
  literal(value.modulePolicy, 'closed-manifest', `${path}.modulePolicy`, 'E_ANIMATION_SCRIPT_PROTOCOL');
  literal(value.clock, 'injected-integer-microseconds', `${path}.clock`, 'E_ANIMATION_SCRIPT_PROTOCOL');
  literal(value.random, 'injected-seeded-xoshiro128', `${path}.random`, 'E_ANIMATION_SCRIPT_PROTOCOL');
  return {
    source: 'luau', sourcePolicy: 'build-time-only', sourceRevisionSha256: revision,
    artifact: PORTABLE_SCRIPT_ARTIFACT, numericMode: 'ieee754-f64-canonical-nan', stringMode: 'utf8',
    tableMode: 'insertion-ordered-own-keys', modulePolicy: 'closed-manifest',
    clock: 'injected-integer-microseconds', random: 'injected-seeded-xoshiro128',
  };
}

function parseLimits(input: unknown, path: string, hard: SandboxedAnimationScriptLimits): SandboxedAnimationScriptLimits {
  const value = object(input, path);
  exact(value, path, LIMIT_KEYS);
  const parsed = {} as Record<(typeof LIMIT_KEYS)[number], number>;
  for (const key of LIMIT_KEYS) {
    const current = integer(value[key], `${path}.${key}`, 1, hard[key]);
    parsed[key] = current;
  }
  if (parsed.maxInstructionsPerInvocation < parsed.maxInstructionsPerFunction) {
    scriptFormatError('E_ANIMATION_SCRIPT_LIMIT', `${path}.maxInstructionsPerInvocation`, 'Invocation budget cannot be lower than one function budget.');
  }
  if (parsed.maxInstructionsPerScope < parsed.maxInstructionsPerInvocation) {
    scriptFormatError('E_ANIMATION_SCRIPT_LIMIT', `${path}.maxInstructionsPerScope`, 'Scope instruction budget cannot be lower than one invocation budget.');
  }
  return parsed as unknown as SandboxedAnimationScriptLimits;
}

function parseProgram(
  input: unknown,
  path: string,
  limits: SandboxedAnimationScriptLimits,
  revision: string,
): PortableScriptProgram {
  const value = object(input, path);
  if (utf8Bytes(JSON.stringify(value)) > limits.maxProgramBytes) limit(path, `Program bytes exceed ${limits.maxProgramBytes}.`);
  exact(value, path, ['id', 'protocol', 'artifact', 'sourceRevisionSha256', 'constants', 'functions', 'entrypoints', 'capabilities']);
  const id = identifier(value.id, `${path}.id`);
  const protocol = enumeration(value.protocol, `${path}.protocol`, PROTOCOLS, 'E_ANIMATION_SCRIPT_PROTOCOL');
  literal(value.artifact, PORTABLE_SCRIPT_ARTIFACT, `${path}.artifact`, 'E_ANIMATION_SCRIPT_ARTIFACT');
  literal(value.sourceRevisionSha256, revision, `${path}.sourceRevisionSha256`, 'E_ANIMATION_SCRIPT_ARTIFACT');
  const constantsInput = array(value.constants, `${path}.constants`);
  if (constantsInput.length > limits.maxConstants) limit(`${path}.constants`, `Constant count exceeds ${limits.maxConstants}.`);
  let stringBytes = 0;
  const constants = constantsInput.map((constant, index): PortableScriptConstant => {
    const constantPath = `${path}.constants[${index}]`;
    if (constant === null || typeof constant === 'boolean') return constant;
    if (typeof constant === 'number') {
      if (!Number.isFinite(constant)) scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', constantPath, 'Constants must be finite.');
      return Object.is(constant, -0) ? 0 : constant;
    }
    if (typeof constant === 'string') {
      stringBytes += utf8Bytes(constant);
      if (stringBytes > limits.maxStringBytes) limit(constantPath, `String bytes exceed ${limits.maxStringBytes}.`);
      return constant;
    }
    scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', constantPath, 'Constant must be null, boolean, finite number, or string.');
  });
  const functionsInput = array(value.functions, `${path}.functions`);
  if (functionsInput.length === 0 || functionsInput.length > limits.maxFunctions) {
    limit(`${path}.functions`, `Function count must be 1..${limits.maxFunctions}.`);
  }
  const functions = functionsInput.map((entry, index) => parseFunction(entry, `${path}.functions[${index}]`, limits, constants.length));
  unique(functions.map(entry => entry.id), `${path}.functions`);
  const functionIds = new Set(functions.map(entry => entry.id));
  for (const [functionIndex, func] of functions.entries()) validateFunctionReferences(func, `${path}.functions[${functionIndex}]`, functionIds);
  const entrypoints = parseEntrypoints(value.entrypoints, `${path}.entrypoints`, protocol, functionIds);
  const capabilityInput = array(value.capabilities, `${path}.capabilities`);
  const capabilities = capabilityInput.map((entry, index) => enumeration(entry, `${path}.capabilities[${index}]`, CAPABILITIES, 'E_ANIMATION_SCRIPT_CAPABILITY'));
  unique(capabilities, `${path}.capabilities`);
  const allowed = PROTOCOL_CAPABILITIES[protocol];
  for (const [index, capability] of capabilities.entries()) {
    if (!allowed.has(capability)) scriptFormatError('E_ANIMATION_SCRIPT_CAPABILITY', `${path}.capabilities[${index}]`, `${protocol} cannot request ${capability}.`);
  }
  const declared = new Set(capabilities);
  for (const [functionIndex, func] of functions.entries()) {
    for (const [instructionIndex, instruction] of func.instructions.entries()) {
      if (instruction.op === 'capability' && !declared.has(instruction.capability)) {
        scriptFormatError('E_ANIMATION_SCRIPT_CAPABILITY', `${path}.functions[${functionIndex}].instructions[${instructionIndex}].capability`, 'Instruction uses an undeclared capability.');
      }
    }
  }
  return { id, protocol, artifact: PORTABLE_SCRIPT_ARTIFACT, sourceRevisionSha256: revision, constants, functions, entrypoints, capabilities };
}

function parseFunction(input: unknown, path: string, limits: SandboxedAnimationScriptLimits, constantCount: number): PortableScriptFunction {
  const value = object(input, path);
  exact(value, path, ['id', 'parameters', 'registers', 'instructions']);
  const id = identifier(value.id, `${path}.id`);
  const parameters = integer(value.parameters, `${path}.parameters`, 0, limits.maxRegistersPerFunction);
  const registers = integer(value.registers, `${path}.registers`, 1, limits.maxRegistersPerFunction);
  if (parameters > registers) scriptFormatError('E_ANIMATION_SCRIPT_ARTIFACT', `${path}.parameters`, 'Parameter count exceeds register count.');
  const instructionInput = array(value.instructions, `${path}.instructions`);
  if (instructionInput.length === 0 || instructionInput.length > limits.maxInstructionsPerFunction) {
    limit(`${path}.instructions`, `Instruction count must be 1..${limits.maxInstructionsPerFunction}.`);
  }
  const instructions = instructionInput.map((entry, index) => parseInstruction(entry, `${path}.instructions[${index}]`, registers, constantCount, instructionInput.length));
  return { id, parameters, registers, instructions };
}

function parseInstruction(input: unknown, path: string, registers: number, constants: number, instructionCount: number): PortableScriptInstruction {
  const value = object(input, path);
  const op = string(value.op, `${path}.op`, 32);
  const location = value.location === undefined ? undefined : parseLocation(value.location, `${path}.location`);
  const reg = (key: string) => integer(value[key], `${path}.${key}`, 0, registers - 1);
  const regs = (key: string) => array(value[key], `${path}.${key}`).map((entry, index) => integer(entry, `${path}.${key}[${index}]`, 0, registers - 1));
  switch (op) {
    case 'load-constant':
      exact(value, path, ['op', 'to', 'constant', 'location'], true);
      if (constants === 0) scriptFormatError('E_ANIMATION_SCRIPT_REFERENCE', `${path}.constant`, 'Cannot load from an empty constant table.');
      return { op, to: reg('to'), constant: integer(value.constant, `${path}.constant`, 0, constants - 1), location };
    case 'load-input': exact(value, path, ['op', 'to', 'name', 'location'], true); return { op, to: reg('to'), name: safeKey(value.name, `${path}.name`), location };
    case 'load-context': exact(value, path, ['op', 'to', 'path', 'location'], true); return { op, to: reg('to'), path: array(value.path, `${path}.path`).map((entry, index) => safeKey(entry, `${path}.path[${index}]`)), location };
    case 'random': exact(value, path, ['op', 'to', 'location'], true); return { op, to: reg('to'), location };
    case 'move': exact(value, path, ['op', 'to', 'from', 'location'], true); return { op, to: reg('to'), from: reg('from'), location };
    case 'unary': exact(value, path, ['op', 'to', 'operator', 'value', 'location'], true); return { op, to: reg('to'), operator: enumeration(value.operator, `${path}.operator`, new Set(['negate', 'not', 'length']), 'E_ANIMATION_SCRIPT_ARTIFACT'), value: reg('value'), location };
    case 'binary': exact(value, path, ['op', 'to', 'operator', 'left', 'right', 'location'], true); return { op, to: reg('to'), operator: enumeration(value.operator, `${path}.operator`, new Set(['add', 'subtract', 'multiply', 'divide', 'modulo', 'power', 'equal', 'not-equal', 'less', 'less-equal', 'greater', 'greater-equal', 'and', 'or', 'concat']), 'E_ANIMATION_SCRIPT_ARTIFACT'), left: reg('left'), right: reg('right'), location };
    case 'make-list': exact(value, path, ['op', 'to', 'values', 'location'], true); return { op, to: reg('to'), values: regs('values'), location };
    case 'make-table': {
      exact(value, path, ['op', 'to', 'entries', 'location'], true);
      const entries = array(value.entries, `${path}.entries`).map((entry, index) => {
        const entryPath = `${path}.entries[${index}]`; const item = object(entry, entryPath); exact(item, entryPath, ['key', 'value']);
        return { key: safeKey(item.key, `${entryPath}.key`), value: integer(item.value, `${entryPath}.value`, 0, registers - 1) };
      });
      unique(entries.map(entry => entry.key), `${path}.entries`);
      return { op, to: reg('to'), entries, location };
    }
    case 'get': exact(value, path, ['op', 'to', 'target', 'key', 'location'], true); return { op, to: reg('to'), target: reg('target'), key: reg('key'), location };
    case 'set': exact(value, path, ['op', 'target', 'key', 'value', 'location'], true); return { op, target: reg('target'), key: reg('key'), value: reg('value'), location };
    case 'jump': exact(value, path, ['op', 'target', 'location'], true); return { op, target: integer(value.target, `${path}.target`, 0, instructionCount - 1), location };
    case 'jump-if': exact(value, path, ['op', 'condition', 'target', 'when', 'location'], true); return { op, condition: reg('condition'), target: integer(value.target, `${path}.target`, 0, instructionCount - 1), when: boolean(value.when, `${path}.when`), location };
    case 'call': exact(value, path, ['op', 'to', 'function', 'arguments', 'location'], true); return { op, to: reg('to'), function: identifier(value.function, `${path}.function`), arguments: regs('arguments'), location };
    case 'capability': exact(value, path, ['op', 'to', 'capability', 'arguments', 'location'], true); return { op, to: value.to === undefined ? undefined : reg('to'), capability: enumeration(value.capability, `${path}.capability`, CAPABILITIES, 'E_ANIMATION_SCRIPT_CAPABILITY'), arguments: regs('arguments'), location };
    case 'return': exact(value, path, ['op', 'value', 'location'], true); return { op, value: value.value === undefined ? undefined : reg('value'), location };
    default: return scriptFormatError('E_ANIMATION_SCRIPT_ARTIFACT', `${path}.op`, `Unknown instruction ${JSON.stringify(op)}.`);
  }
}

function validateFunctionReferences(func: PortableScriptFunction, path: string, functions: ReadonlySet<string>): void {
  for (const [index, instruction] of func.instructions.entries()) {
    if (instruction.op === 'call' && !functions.has(instruction.function)) {
      scriptFormatError('E_ANIMATION_SCRIPT_REFERENCE', `${path}.instructions[${index}].function`, `Unknown function ${instruction.function}.`);
    }
  }
}

function parseEntrypoints(input: unknown, path: string, protocol: AnimationScriptProtocol, functions: ReadonlySet<string>): Readonly<Record<string, string>> {
  const value = object(input, path);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const allowed = PROTOCOL_ENTRYPOINTS[protocol];
  for (const [key, raw] of Object.entries(value)) {
    safeKey(key, `${path}.${key}`);
    if (allowed !== undefined && !allowed.has(key)) {
      scriptFormatError('E_ANIMATION_SCRIPT_PROTOCOL', `${path}.${key}`, `${key} is not a ${protocol} lifecycle entrypoint.`);
    }
    const functionId = identifier(raw, `${path}.${key}`);
    if (!functions.has(functionId)) scriptFormatError('E_ANIMATION_SCRIPT_REFERENCE', `${path}.${key}`, `Unknown function ${functionId}.`);
    result[key] = functionId;
  }
  for (const required of REQUIRED_ENTRYPOINTS[protocol]) {
    if (result[required] === undefined) scriptFormatError('E_ANIMATION_SCRIPT_PROTOCOL', `${path}.${required}`, `${protocol} requires ${required}.`);
  }
  return result;
}

function parseShader(input: unknown, path: string, limits: SandboxedAnimationScriptLimits): SandboxedShaderModule {
  const value = object(input, path);
  exact(value, path, ['id', 'language', 'vertexEntryPoint', 'fragmentEntryPoint', 'source', 'bindings', 'targetFormat']);
  const id = identifier(value.id, `${path}.id`);
  literal(value.language, 'wgsl', `${path}.language`, 'E_ANIMATION_SHADER_INVALID');
  const vertexEntryPoint = wgslIdentifier(value.vertexEntryPoint, `${path}.vertexEntryPoint`);
  const fragmentEntryPoint = wgslIdentifier(value.fragmentEntryPoint, `${path}.fragmentEntryPoint`);
  const source = string(value.source, `${path}.source`, limits.maxShaderSourceBytes);
  if (utf8Bytes(source) > limits.maxShaderSourceBytes) shaderLimit(`${path}.source`, `Shader bytes exceed ${limits.maxShaderSourceBytes}.`);
  const tokens = source.match(/[A-Za-z_][A-Za-z0-9_]*|->|[{}()[\]<>@,;:.=+*/%-]/g)?.length ?? 0;
  if (tokens > limits.maxShaderTokens) shaderLimit(`${path}.source`, `Shader tokens exceed ${limits.maxShaderTokens}.`);
  const bindingsInput = array(value.bindings, `${path}.bindings`);
  if (bindingsInput.length > limits.maxShaderBindings) shaderLimit(`${path}.bindings`, `Binding count exceeds ${limits.maxShaderBindings}.`);
  let uniformBytes = 0;
  const bindings = bindingsInput.map((entry, index): SandboxedShaderBinding => {
    const entryPath = `${path}.bindings[${index}]`; const binding = object(entry, entryPath);
    exact(binding, entryPath, ['binding', 'kind', 'visibility', 'maxBytes'], true);
    const kind = enumeration(binding.kind, `${entryPath}.kind`, new Set<SandboxedShaderBinding['kind']>(['uniform-buffer', 'sampled-texture', 'sampler']), 'E_ANIMATION_SHADER_BINDING');
    const visibility = enumeration(binding.visibility, `${entryPath}.visibility`, new Set<SandboxedShaderBinding['visibility']>(['vertex', 'fragment', 'vertex-fragment']), 'E_ANIMATION_SHADER_BINDING');
    const maxBytes = binding.maxBytes === undefined ? undefined : integer(binding.maxBytes, `${entryPath}.maxBytes`, 1, limits.maxUniformBytes);
    if (kind === 'uniform-buffer') {
      if (maxBytes === undefined) scriptFormatError('E_ANIMATION_SHADER_BINDING', `${entryPath}.maxBytes`, 'Uniform buffers require maxBytes.');
      uniformBytes += maxBytes;
    } else if (maxBytes !== undefined) scriptFormatError('E_ANIMATION_SHADER_BINDING', `${entryPath}.maxBytes`, `${kind} cannot declare maxBytes.`);
    return { binding: integer(binding.binding, `${entryPath}.binding`, 0, limits.maxShaderBindings - 1), kind, visibility, maxBytes };
  });
  unique(bindings.map(binding => binding.binding), `${path}.bindings`);
  if (uniformBytes > limits.maxUniformBytes) shaderLimit(`${path}.bindings`, `Uniform bytes exceed ${limits.maxUniformBytes}.`);
  literal(value.targetFormat, 'rgba8unorm', `${path}.targetFormat`, 'E_ANIMATION_SHADER_BINDING');
  return { id, language: 'wgsl', vertexEntryPoint, fragmentEntryPoint, source, bindings, targetFormat: 'rgba8unorm' };
}

function parseLocation(input: unknown, path: string): AnimationScriptSourceLocation {
  const value = object(input, path); exact(value, path, ['sourceId', 'line', 'column']);
  return { sourceId: virtualSourceId(value.sourceId, `${path}.sourceId`), line: integer(value.line, `${path}.line`, 1, 1_000_000), column: integer(value.column, `${path}.column`, 1, 1_000_000) };
}

function virtualSourceId(input: unknown, path: string): string {
  const value = string(input, path, 256);
  if (/[:\\]|(?:^|\/)\.\.(?:\/|$)|^(?:https?|file):/i.test(value)) scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', path, 'Source id must be a virtual relative id without private paths or URLs.');
  return value;
}

function object(input: unknown, path: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', path, 'Expected object.');
  return input as Record<string, unknown>;
}

function array(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', path, 'Expected array.');
  return input;
}

function string(input: unknown, path: string, maxBytes: number): string {
  if (typeof input !== 'string' || utf8Bytes(input) > maxBytes) scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', path, `Expected string of at most ${maxBytes} UTF-8 bytes.`);
  return input;
}

function identifier(input: unknown, path: string): string {
  const value = string(input, path, 128);
  if (!IDENTIFIER.test(value)) scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', path, 'Expected portable lower-case identifier.');
  return value;
}

function wgslIdentifier(input: unknown, path: string): string {
  const value = string(input, path, 128);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) scriptFormatError('E_ANIMATION_SHADER_INVALID', path, 'Expected a WGSL identifier.');
  return value;
}

function safeKey(input: unknown, path: string): string {
  const value = string(input, path, 128);
  if (FORBIDDEN_KEYS.has(value) || value.includes('\0')) scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', path, 'Forbidden table or host-object key.');
  return value;
}

function integer(input: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(input) || (input as number) < min || (input as number) > max) scriptFormatError('E_ANIMATION_SCRIPT_LIMIT', path, `Expected integer in ${min}..${max}.`);
  return input as number;
}

function boolean(input: unknown, path: string): boolean {
  if (typeof input !== 'boolean') scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', path, 'Expected boolean.');
  return input;
}

function literal<T>(input: unknown, expected: T, path: string, code: Parameters<typeof scriptFormatError>[0]): asserts input is T {
  if (input !== expected) scriptFormatError(code, path, `Expected ${JSON.stringify(expected)}.`);
}

function enumeration<T extends string>(input: unknown, path: string, values: ReadonlySet<T>, code: Parameters<typeof scriptFormatError>[0]): T {
  if (typeof input !== 'string' || !values.has(input as T)) scriptFormatError(code, path, `Expected one of ${[...values].join(', ')}.`);
  return input as T;
}

function exact(value: Record<string, unknown>, path: string, allowed: readonly string[], optional = false): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', `${path}.${key}`, 'Unknown field.');
  if (!optional) for (const key of allowed) if (!(key in value)) scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', `${path}.${key}`, 'Missing field.');
}

function unique(values: readonly (string | number)[], path: string): void {
  const seen = new Set<string | number>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) scriptFormatError('E_ANIMATION_SCRIPT_REFERENCE', `${path}[${index}]`, `Duplicate identity ${String(value)}.`);
    seen.add(value);
  }
}

function limit(path: string, message: string): never { return scriptFormatError('E_ANIMATION_SCRIPT_LIMIT', path, message); }
function shaderLimit(path: string, message: string): never { return scriptFormatError('E_ANIMATION_SHADER_BUDGET', path, message); }
function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }

function assertPlainDataGraph(value: unknown, path: string, active: Set<object>, visited: Set<object>): void {
  if (value === null || typeof value !== 'object') return;
  const objectValue = value as object;
  if (active.has(objectValue)) scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', path, 'Cyclic input graph.');
  if (visited.has(objectValue)) return;
  const prototype = Object.getPrototypeOf(objectValue);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', path, 'Expected a plain data array.');
  } else if (prototype !== Object.prototype && prototype !== null) {
    scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', path, 'Expected a plain data object.');
  }
  active.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    if (typeof key !== 'string') scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', path, 'Symbol data keys are forbidden.');
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      scriptFormatError('E_ANIMATION_SCRIPT_FORMAT', `${path}.${key}`, 'Only enumerable data properties are allowed.');
    }
    assertPlainDataGraph(descriptor.value, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`, active, visited);
  }
  active.delete(objectValue); visited.add(objectValue);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry, seen);
  return Object.freeze(value);
}
