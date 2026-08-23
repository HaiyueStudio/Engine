import { scriptRuntimeFail } from './diagnostics.js';
import type { RuntimeScriptLimits, SandboxedShaderBinding, SandboxedShaderModule } from './runtime-types.js';

export interface ValidatedSandboxedShader {
  readonly module: SandboxedShaderModule;
  readonly tokenCount: number;
  readonly sourceBytes: number;
  readonly bindingNames: ReadonlyMap<number, string>;
  readonly canonicalKey: string;
}

const FORBIDDEN = Object.freeze([
  [/@compute\b/, 'compute entry points'],
  [/\bvar\s*<\s*storage\b/, 'storage address space'],
  [/\bvar\s*<\s*workgroup\b/, 'workgroup address space'],
  [/\bvar\s*<\s*private\b/, 'module private state'],
  [/\batomic\w*\b/, 'atomics'],
  [/\btexture_storage_\w+\b/, 'storage textures'],
  [/\btexture_external\b/, 'external textures'],
  [/\btextureStore\b/, 'texture writes'],
  [/\bworkgroupBarrier\b|\bstorageBarrier\b|\btextureBarrier\b/, 'barriers'],
  [/\bwhile\s*\(|\bloop\s*\{|\bfor\s*\(/, 'dynamic loops'],
  [/\benable\b|\brequires\b/, 'optional language extensions'],
  [/\bdiagnostic\s*\(/, 'diagnostic filters'],
  [/#(?:include|define|import)\b/, 'preprocessor-like directives'],
] as const);

export function validateSandboxedWgsl(module: SandboxedShaderModule, limits: RuntimeScriptLimits): ValidatedSandboxedShader {
  const sourceBytes = new TextEncoder().encode(module.source).byteLength;
  if (sourceBytes > limits.maxShaderSourceBytes) shaderBudget(`Shader source exceeds ${limits.maxShaderSourceBytes} bytes.`);
  const source = stripComments(module.source);
  const tokens = source.match(/[A-Za-z_][A-Za-z0-9_]*|(?:0x)?[0-9]+(?:\.[0-9]+)?|->|&&|\|\||==|!=|<=|>=|[{}()[\]<>@,;:.=+*/%!?&|-]/g) ?? [];
  if (tokens.length > limits.maxShaderTokens) shaderBudget(`Shader token count exceeds ${limits.maxShaderTokens}.`);
  for (const [pattern, feature] of FORBIDDEN) if (pattern.test(source)) shaderInvalid(`Forbidden ${feature}.`);
  const vertices = [...source.matchAll(/@vertex\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]);
  const fragments = [...source.matchAll(/@fragment\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]);
  if (vertices.length !== 1 || vertices[0] !== module.vertexEntryPoint) shaderInvalid('Exactly one declared vertex entry point must match the manifest.');
  if (fragments.length !== 1 || fragments[0] !== module.fragmentEntryPoint) shaderInvalid('Exactly one declared fragment entry point must match the manifest.');
  validateBalanced(source);
  const declarations = parseBindings(source);
  if (declarations.size > limits.maxShaderBindings) shaderBudget(`Shader binding count exceeds ${limits.maxShaderBindings}.`);
  if (declarations.size !== module.bindings.length) shaderBinding('WGSL and declared binding counts differ.');
  let uniformBytes = 0;
  let textures = 0;
  for (const descriptor of module.bindings) {
    const declaration = declarations.get(descriptor.binding);
    if (declaration === undefined) shaderBinding(`Declared binding ${descriptor.binding} is missing from WGSL.`);
    if (!matchesBinding(descriptor, declaration.type)) shaderBinding(`Binding ${descriptor.binding} WGSL type does not match ${descriptor.kind}.`);
    if (descriptor.kind === 'uniform-buffer') uniformBytes += descriptor.maxBytes ?? 0;
    if (descriptor.kind === 'sampled-texture') textures += 1;
  }
  if (textures > limits.maxTextures) shaderBudget(`Sampled texture count exceeds ${limits.maxTextures}.`);
  if (uniformBytes > limits.maxUniformBytes) shaderBudget(`Uniform bytes exceed ${limits.maxUniformBytes}.`);
  const declaredBindings = new Set(module.bindings.map(binding => binding.binding));
  for (const binding of declarations.keys()) if (!declaredBindings.has(binding)) shaderBinding(`WGSL binding ${binding} is not declared.`);
  return Object.freeze({
    module,
    tokenCount: tokens.length,
    sourceBytes,
    bindingNames: new Map([...declarations].map(([binding, declaration]) => [binding, declaration.name])),
    canonicalKey: JSON.stringify([
      module.id,
      module.vertexEntryPoint,
      module.fragmentEntryPoint,
      module.targetFormat,
      module.source,
      module.bindings.map(binding => [binding.binding, binding.kind, binding.visibility, binding.maxBytes ?? 0]),
    ]),
  });
}

interface BindingDeclaration { readonly name: string; readonly type: string }

function parseBindings(source: string): Map<number, BindingDeclaration> {
  const result = new Map<number, BindingDeclaration>();
  const declarations = source.matchAll(/@group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)\s*var(?:\s*<\s*([^>]+)\s*>)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^;]+);/g);
  for (const match of declarations) {
    const group = Number(match[1]); const binding = Number(match[2]);
    if (group !== 0) shaderBinding('Only isolated bind group 0 is allowed.');
    if (result.has(binding)) shaderBinding(`Duplicate binding ${binding}.`);
    const addressSpace = match[3]?.trim();
    const type = `${addressSpace === undefined ? '' : `<${addressSpace}>`}:${match[5]!.replace(/\s+/g, '')}`;
    result.set(binding, { name: match[4]!, type });
  }
  const everyGroup = source.matchAll(/@group\s*\(\s*(\d+)\s*\)/g);
  for (const match of everyGroup) if (Number(match[1]) !== 0) shaderBinding('Only isolated bind group 0 is allowed.');
  return result;
}

function matchesBinding(binding: SandboxedShaderBinding, type: string): boolean {
  if (binding.kind === 'uniform-buffer') return /^<uniform>:[A-Za-z_][A-Za-z0-9_]*$/.test(type);
  if (binding.kind === 'sampled-texture') return /^:texture_2d<f32>$/.test(type);
  return /^:sampler$/.test(type);
}

function stripComments(source: string): string {
  let output = '';
  for (let index = 0; index < source.length;) {
    if (source[index] === '/' && source[index + 1] === '/') {
      index += 2; while (index < source.length && source[index] !== '\n') index += 1; output += '\n'; continue;
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      index += 2; let depth = 1;
      while (index < source.length && depth > 0) {
        if (source[index] === '/' && source[index + 1] === '*') { depth += 1; index += 2; }
        else if (source[index] === '*' && source[index + 1] === '/') { depth -= 1; index += 2; }
        else { if (source[index] === '\n') output += '\n'; index += 1; }
      }
      if (depth !== 0) shaderInvalid('Unterminated block comment.');
      continue;
    }
    output += source[index++];
  }
  return output;
}

function validateBalanced(source: string): void {
  const stack: string[] = []; const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (const character of source) {
    if (character === '(' || character === '[' || character === '{') stack.push(character);
    else if (character === ')' || character === ']' || character === '}') if (stack.pop() !== pairs[character]) shaderInvalid('Unbalanced WGSL delimiters.');
  }
  if (stack.length !== 0) shaderInvalid('Unbalanced WGSL delimiters.');
}

function shaderInvalid(message: string): never { return scriptRuntimeFail('E_SHADER_VALIDATION', message, { path: 'shader.source' }); }
function shaderBinding(message: string): never { return scriptRuntimeFail('E_SHADER_BINDING', message, { path: 'shader.bindings' }); }
function shaderBudget(message: string): never { return scriptRuntimeFail('E_SHADER_BUDGET', message, { path: 'shader.limits' }); }
