export type WgslDefineValue = boolean | number | string;

export interface WgslFeatureModule {
  readonly id: string;
  readonly source: string;
  readonly sourceName: string;
  readonly dependencies: readonly WgslFeatureModule[];
  readonly exports: readonly string[];
}

export interface WgslFeatureModuleOptions {
  id: string;
  source: string;
  sourceName?: string;
  dependencies?: readonly WgslFeatureModule[];
  exports: readonly string[];
}

export interface ComposeWgslOptions {
  label: string;
  source: string;
  sourceName?: string;
  features?: readonly WgslFeatureModule[];
  defines?: Readonly<Record<string, WgslDefineValue>>;
}

export interface WgslSourceSpan {
  readonly moduleId: string;
  readonly sourceName: string;
  readonly generatedStartLine: number;
  readonly generatedEndLine: number;
}

export interface ComposedWgsl {
  readonly label: string;
  readonly code: string;
  /** Canonical key suitable for shader and pipeline caches. */
  readonly featureKey: string;
  readonly featureIds: readonly string[];
  readonly defines: Readonly<Record<string, WgslDefineValue>>;
  readonly sourceMap: readonly WgslSourceSpan[];
}

export interface WgslSourceLocation {
  readonly moduleId: string;
  readonly sourceName: string;
  readonly line: number;
  readonly column: number;
  readonly generatedLine: number;
}

interface WgslCompilationReport {
  readonly errors: readonly string[];
  readonly infoError: unknown | null;
}

const shaderCompilationReports = new WeakMap<GPUShaderModule, Promise<WgslCompilationReport>>();

const MODULE_ID = /^[a-z][a-z0-9.-]*$/;
const SYMBOL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function defineWgslFeatureModule(options: WgslFeatureModuleOptions): WgslFeatureModule {
  if (!MODULE_ID.test(options.id)) throw new Error(`Invalid WGSL feature module id: ${options.id}`);
  if (!options.source.trim()) throw new Error(`WGSL feature module ${options.id} has no source`);
  if (options.exports.length < 1) throw new Error(`WGSL feature module ${options.id} must declare at least one export`);
  const exports = [...new Set(options.exports)];
  for (const symbol of exports) {
    if (!SYMBOL_NAME.test(symbol)) throw new Error(`Invalid WGSL export ${symbol} in ${options.id}`);
    if (!new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(options.source)) {
      throw new Error(`WGSL feature module ${options.id} declares missing export ${symbol}`);
    }
  }
  return Object.freeze({
    id: options.id,
    source: normalizeSource(options.source),
    sourceName: options.sourceName ?? `${options.id}.wgsl`,
    dependencies: Object.freeze([...(options.dependencies ?? [])]),
    exports: Object.freeze(exports),
  });
}

export function composeWgsl(options: ComposeWgslOptions): ComposedWgsl {
  const ordered: WgslFeatureModule[] = [];
  const visiting = new Set<string>();
  const visited = new Map<string, WgslFeatureModule>();

  const visit = (feature: WgslFeatureModule, path: readonly string[]): void => {
    const previous = visited.get(feature.id);
    if (previous) {
      if (previous !== feature) throw new Error(`Conflicting WGSL feature module id: ${feature.id}`);
      return;
    }
    if (visiting.has(feature.id)) throw new Error(`WGSL feature dependency cycle: ${[...path, feature.id].join(' -> ')}`);
    visiting.add(feature.id);
    for (const dependency of [...feature.dependencies].sort((a, b) => a.id.localeCompare(b.id))) {
      visit(dependency, [...path, feature.id]);
    }
    visiting.delete(feature.id);
    visited.set(feature.id, feature);
    ordered.push(feature);
  };
  for (const feature of [...(options.features ?? [])].sort((a, b) => a.id.localeCompare(b.id))) visit(feature, []);

  const symbolOwners = new Map<string, string>();
  for (const feature of ordered) {
    for (const symbol of feature.exports) {
      const owner = symbolOwners.get(symbol);
      if (owner) throw new Error(`WGSL export ${symbol} is provided by both ${owner} and ${feature.id}`);
      symbolOwners.set(symbol, feature.id);
    }
  }
  assertUniqueResourceBindings([
    ...ordered.map(feature => ({
      moduleId: feature.id,
      sourceName: feature.sourceName,
      source: feature.source,
    })),
    {
      moduleId: '@entry',
      sourceName: options.sourceName ?? `${options.label}.wgsl`,
      source: options.source,
    },
  ]);

  const defines = Object.freeze({ ...(options.defines ?? {}) });
  const defineNames = Object.keys(defines).sort();
  for (const name of defineNames) {
    if (!SYMBOL_NAME.test(name)) throw new Error(`Invalid WGSL define name: ${name}`);
  }

  const lines: string[] = [];
  const sourceMap: WgslSourceSpan[] = [];
  const append = (moduleId: string, sourceName: string, source: string): void => {
    lines.push(`// haiyue:module ${moduleId} (${sourceName})`);
    const generatedStartLine = lines.length + 1;
    const sourceLines = normalizeSource(source).split('\n');
    lines.push(...sourceLines);
    sourceMap.push(Object.freeze({
      moduleId,
      sourceName,
      generatedStartLine,
      generatedEndLine: generatedStartLine + sourceLines.length - 1,
    }));
    lines.push('');
  };

  if (defineNames.length > 0) {
    append('@defines', `${options.label}:defines`, defineNames
      .map(name => `const ${name} = ${formatDefine(defines[name]!)};`)
      .join('\n'));
  }
  for (const feature of ordered) append(feature.id, feature.sourceName, feature.source);
  append('@entry', options.sourceName ?? `${options.label}.wgsl`, options.source);
  if (lines[lines.length - 1] === '') lines.pop();

  const featureIds = Object.freeze(ordered.map(feature => feature.id));
  const defineKey = defineNames.map(name => `${name}=${formatDefine(defines[name]!)}`).join(',');
  return Object.freeze({
    label: options.label,
    code: `${lines.join('\n')}\n`,
    featureKey: `${[...featureIds].sort().join('+')}|${defineKey}`,
    featureIds,
    defines,
    sourceMap: Object.freeze(sourceMap),
  });
}

export function mapWgslSourceLocation(
  composition: ComposedWgsl,
  generatedLine: number,
  column = 1,
): WgslSourceLocation | null {
  const span = composition.sourceMap.find(candidate =>
    generatedLine >= candidate.generatedStartLine && generatedLine <= candidate.generatedEndLine);
  if (!span) return null;
  return {
    moduleId: span.moduleId,
    sourceName: span.sourceName,
    line: generatedLine - span.generatedStartLine + 1,
    column,
    generatedLine,
  };
}

export function formatWgslCompilationMessage(
  composition: ComposedWgsl,
  message: Pick<GPUCompilationMessage, 'message' | 'lineNum' | 'linePos' | 'type'>,
): string {
  const location = mapWgslSourceLocation(composition, message.lineNum, message.linePos);
  const prefix = location
    ? `${location.sourceName}:${location.line}:${location.column}`
    : `${composition.label}:generated:${message.lineNum}:${message.linePos}`;
  return `${prefix} [${message.type}] ${message.message}`;
}

export function createComposedShaderModule(device: GPUDevice, composition: ComposedWgsl): GPUShaderModule {
  const module = device.createShaderModule({ label: composition.label, code: composition.code });
  const getCompilationInfo = (module as GPUShaderModule & {
    getCompilationInfo?: () => Promise<GPUCompilationInfo>;
  }).getCompilationInfo;
  if (!getCompilationInfo) return module;
  const report = getCompilationInfo.call(module).then(info => {
    const errors: string[] = [];
    for (const message of info.messages) {
      if (message.type === 'info') continue;
      const formatted = `[WGSL] ${formatWgslCompilationMessage(composition, message)}`;
      if (message.type === 'error') {
        errors.push(formatted);
        console.error(formatted);
      }
      else console.warn(formatted);
    }
    return { errors: Object.freeze(errors), infoError: null };
  }).catch((infoError: unknown) => ({ errors: Object.freeze([]), infoError }));
  shaderCompilationReports.set(module, report);
  return module;
}

/**
 * Waits for the mapped WGSL diagnostics associated with a composed module.
 * Async pipeline creation and real-WebGPU gates use this to turn shader errors
 * into deterministic failures instead of background console messages.
 */
export async function assertWgslShaderModuleCompilation(module: GPUShaderModule): Promise<void> {
  const reportPromise = shaderCompilationReports.get(module);
  if (!reportPromise) return;
  const report = await reportPromise;
  if (report.infoError) {
    throw new Error('Failed to read WGSL compilation diagnostics.', { cause: report.infoError });
  }
  if (report.errors.length > 0) {
    throw new Error(`WGSL compilation failed:\n${report.errors.join('\n')}`);
  }
}

function formatDefine(value: WgslDefineValue): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid WGSL numeric define: ${value}`);
    return String(value);
  }
  const normalized = value.trim();
  if (!normalized || /[\r\n;]/.test(normalized)) throw new Error(`Invalid WGSL define expression: ${value}`);
  return normalized;
}

function normalizeSource(source: string): string {
  return source.replace(/\r\n?/g, '\n').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertUniqueResourceBindings(
  modules: readonly { moduleId: string; sourceName: string; source: string }[],
): void {
  const owners = new Map<string, { moduleId: string; sourceName: string }>();
  const bindingPattern = /@group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)/g;
  for (const module of modules) {
    const source = stripWgslComments(module.source);
    for (const match of source.matchAll(bindingPattern)) {
      const key = `${match[1]}:${match[2]}`;
      const owner = owners.get(key);
      if (owner) {
        throw new Error(
          `WGSL binding @group(${match[1]}) @binding(${match[2]}) is declared by both `
          + `${owner.moduleId} (${owner.sourceName}) and ${module.moduleId} (${module.sourceName})`,
        );
      }
      owners.set(key, { moduleId: module.moduleId, sourceName: module.sourceName });
    }
  }
}

function stripWgslComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}
