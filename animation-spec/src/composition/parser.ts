import {HyaCompositionError} from './errors.js';
import {parseAnimation} from '../parser.js';
import type {AnimationDocument} from '../types.js';
import {compositionPartValidators} from './builtin-parts.js';
import {canonicalCompositionJson, compositionLimits, freezeComposition, readCompositionSource} from './json.js';
import {HYA_COMPOSITION_FORMAT, HYA_COMPOSITION_VERSION, type HyaCompositionDocument,
  type HyaCompositionPart, type HyaCompositionTarget, type HyaCompositionParseOptions,
  type HyaCompositionParseResult, type HyaCompositionDiagnostic, type HyaCompositionPlan} from './types.js';

function fail(path: string, message: string): never {throw new HyaCompositionError('E_HYA_COMPOSITION_FORMAT', path, message);}
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'Expected object.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, names: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!names.includes(key)) fail(path + '.' + key, 'Unknown field.');
  for (const key of names) if (!(key in value)) fail(path + '.' + key, 'Missing field.');
}
function array(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'Expected array.');
  if (value.length > maximum) throw new HyaCompositionError('E_HYA_COMPOSITION_LIMIT', path, 'Count ceiling exceeded.');
  return value;
}
function id(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\u0000-\u001f]/u.test(value)) fail(path, 'Expected a bounded stable ID.');
  return value;
}
function extension(value: unknown, path: string): string {
  const result = id(value, path);
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+@[1-9][0-9]*$/iu.test(result)) fail(path, 'Expected a namespaced major-version ID.');
  return result;
}
function strings(value: unknown, path: string, maximum: number, capability = false): string[] {
  const result = array(value, path, maximum).map((v, i) => capability ? extension(v, `${path}[${i}]`) : id(v, `${path}[${i}]`));
  if (new Set(result).size !== result.length) fail(path, 'Duplicate IDs are forbidden.');
  return result;
}
function strict(options: HyaCompositionParseOptions): boolean {
  if (options.strict !== undefined && typeof options.strict !== 'boolean') fail('$options.strict', 'Expected boolean.');
  return options.strict !== false;
}

export function parseHyaComposition(source: unknown, options: HyaCompositionParseOptions = {}): HyaCompositionParseResult {
  const limits = compositionLimits(options.limits), isStrict = strict(options);
  if (options.validators) for (const key of options.validators.keys()) if (compositionPartValidators.has(key))
    fail('$options.validators', 'Built-in format validators cannot be replaced.');
  const root = object(freezeComposition(readCompositionSource(source, limits)), '$');
  keys(root, ['format', 'version', 'parts', 'targets'], '$');
  if (root.format !== HYA_COMPOSITION_FORMAT) fail('$.format', 'Expected haiyue-composition.');
  if (root.version !== HYA_COMPOSITION_VERSION) throw new HyaCompositionError('E_HYA_COMPOSITION_VERSION', '$.version', 'Unsupported composition version.');
  const parts = array(root.parts, '$.parts', limits.maxParts), byId = new Map<string, HyaCompositionPart>();
  const diagnostics: HyaCompositionDiagnostic[] = [];
  for (const [i, value] of parts.entries()) {
    const path = `$.parts[${i}]`, part = object(value, path);
    keys(part, ['id', 'extension', 'required', 'requires', 'dependencies', 'document'], path);
    const partId = id(part.id, path + '.id'), partExtension = extension(part.extension, path + '.extension');
    if (byId.has(partId)) fail(path + '.id', 'Duplicate part ID.');
    if (typeof part.required !== 'boolean') fail(path + '.required', 'Expected explicit boolean.');
    strings(part.requires, path + '.requires', limits.maxRequirementsPerPart, true);
    strings(part.dependencies, path + '.dependencies', limits.maxParts);
    const validator = partExtension === 'org.haiyue.animation-core@1' && options.coreExtensions
      ? (value: HyaCompositionPart['document']): void => {parseAnimation(value as unknown as AnimationDocument, {extensions: options.coreExtensions!});}
      : compositionPartValidators.get(partExtension) ?? options.validators?.get(partExtension);
    if (!validator) {
      if (part.required || isStrict) throw new HyaCompositionError(part.required ? 'E_HYA_COMPOSITION_REQUIRED' : 'E_HYA_COMPOSITION_OPTIONAL', path + '.extension', 'No format validator is registered.', partExtension);
      diagnostics.push({code: 'W_HYA_COMPOSITION_OPTIONAL_SKIPPED', path: path + '.extension', capability: partExtension, part: partId});
    } else {
      try {validator(part.document as HyaCompositionPart['document']);}
      catch (error) {
        const cause = error as {code?: unknown; path?: unknown};
        const suffix = typeof cause?.path === 'string' && cause.path.startsWith('$') ? cause.path.slice(1) : '';
        throw new HyaCompositionError('E_HYA_COMPOSITION_PART', path + '.document' + suffix, 'Part validation failed.', partExtension, typeof cause?.code === 'string' ? cause.code : undefined);
      }
    }
    byId.set(partId, part as unknown as HyaCompositionPart);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (part: HyaCompositionPart): void => {
    if (visiting.has(part.id)) throw new HyaCompositionError('E_HYA_COMPOSITION_GRAPH', '$.parts', 'Part dependency cycle.', part.extension);
    if (visited.has(part.id)) return;
    visiting.add(part.id);
    for (const dependency of part.dependencies) {
      const other = byId.get(dependency);
      if (!other) throw new HyaCompositionError('E_HYA_COMPOSITION_REFERENCE', '$.parts', 'Missing dependency ' + dependency, part.extension);
      visit(other);
    }
    visiting.delete(part.id); visited.add(part.id);
  };
  byId.forEach(visit);
  const targetIds = new Set<string>();
  const targetLookups = new Map<string, ReturnType<typeof targetLookup>>();
  for (const [i, value] of array(root.targets, '$.targets', limits.maxTargets).entries()) {
    const path = `$.targets[${i}]`, target = object(value, path);
    keys(target, ['id', 'part', 'kind', 'address'], path);
    const targetId = id(target.id, path + '.id'), partId = id(target.part, path + '.part');
    if (targetIds.has(targetId)) fail(path + '.id', 'Duplicate target alias.');
    targetIds.add(targetId);
    const part = byId.get(partId);
    if (!part) throw new HyaCompositionError('E_HYA_COMPOSITION_REFERENCE', path + '.part', 'Target part does not exist.');
    const address = array(target.address, path + '.address', 2).map((v, j) => id(v, `${path}.address[${j}]`));
    if (!address.length) fail(path + '.address', 'Target address must not be empty.');
    const kind = target.kind;
    if (!['animation-node', 'layout-node', 'text-block', 'asset', 'state-input', 'interaction-target', 'semantic-node', 'audio-cue'].includes(kind as string)) fail(path + '.kind', 'Unknown target kind.');
    if (!diagnostics.some(d => d.part === partId)) {
      let lookup = targetLookups.get(partId);
      if (!lookup) {lookup = targetLookup(part); targetLookups.set(partId, lookup);}
      if (!lookup(kind as HyaCompositionTarget['kind'], address))
        throw new HyaCompositionError('E_HYA_COMPOSITION_REFERENCE', path + '.address', 'Target address does not exist in its typed part.', part.extension);
    }
  }
  const targets = new Map((root.targets as unknown as HyaCompositionTarget[]).map(target => [target.id, target]));
  for (const [i, part] of [...byId.values()].entries()) if (part.extension === 'org.haiyue.data-binding@1') {
    const bindings = (part.document as {readonly bindings: readonly {readonly target: string}[]}).bindings;
    for (const [j, binding] of bindings.entries()) {
      const target = targets.get(binding.target), path = `$.parts[${i}].document.bindings[${j}].target`;
      if (!target) throw new HyaCompositionError('E_HYA_COMPOSITION_REFERENCE', path, 'Data target alias is not declared.', part.extension);
      if (target.part !== part.id && !part.dependencies.includes(target.part))
        throw new HyaCompositionError('E_HYA_COMPOSITION_GRAPH', `$.parts[${i}].dependencies`, 'Data target part must be an explicit dependency.', part.extension);
    }
  }
  return freezeComposition({document: root as unknown as HyaCompositionDocument, diagnostics});
}

/** Index validated part IDs once; many aliases must not repeatedly scan a large document. */
function targetLookup(part: HyaCompositionPart): (kind: HyaCompositionTarget['kind'], address: readonly string[]) => boolean {
  const doc = part.document as Record<string, unknown>;
  const ids = (value: unknown): Set<string> => new Set((value as readonly {readonly id: string}[] | undefined)?.map(item => item.id) ?? []);
  const nested = (value: unknown, key: string): Map<string, Set<string>> => new Map((value as readonly Record<string, unknown>[]).map(item => [item.id as string, ids(item[key])]));
  const one = new Map<HyaCompositionTarget['kind'], Set<string>>();
  const two = new Map<HyaCompositionTarget['kind'], Map<string, Set<string>>>();
  switch (part.extension) {
    case 'org.haiyue.animation-core@1': one.set('animation-node', ids(doc.nodes)); one.set('asset', ids(doc.resources)); break;
    case 'org.haiyue.layout-2d@1': two.set('layout-node', nested(doc.artboards, 'nodes')); one.set('text-block', ids(doc.textBlocks)); one.set('asset', ids(doc.assets)); break;
    case 'org.haiyue.animation-state-machine@2': two.set('state-input', nested(doc.stateMachines, 'inputs')); break;
    case 'org.haiyue.interaction@1': one.set('interaction-target', ids(doc.targets)); break;
    case 'org.haiyue.semantics@1': one.set('semantic-node', ids(doc.nodes)); break;
    case 'org.haiyue.audio-events@1': one.set('audio-cue', ids(doc.cues)); break;
  }
  return (kind, address) => address.length === 1 ? one.get(kind)?.has(address[0]!) === true
    : address.length === 2 && two.get(kind)?.get(address[0]!)?.has(address[1]!) === true;
}

/** Deterministic JSON is a new envelope codec, not a replacement HYA/HYLA binary container. */
export function encodeHyaComposition(source: unknown, options: HyaCompositionParseOptions = {}): Uint8Array {
  const {document} = parseHyaComposition(source, options);
  return new TextEncoder().encode(canonicalCompositionJson(document as unknown as HyaCompositionPart['document']));
}

export function negotiateHyaComposition(source: unknown, capabilities: ReadonlySet<string>, options: HyaCompositionParseOptions = {}): HyaCompositionPlan {
  const {document, diagnostics: parsed} = parseHyaComposition(source, options), diagnostics = [...parsed], isStrict = strict(options);
  const skipped = new Set(parsed.map(d => d.part)), active = new Set<string>();
  document.parts.forEach((part, i) => {
    if (skipped.has(part.id)) return;
    const needs = [part.extension, ...part.requires], missing = needs.find(capability => !capabilities.has(capability));
    if (missing) {
      const path = missing === part.extension ? `$.parts[${i}].extension` : `$.parts[${i}].requires[${part.requires.indexOf(missing)}]`;
      if (part.required || isStrict) throw new HyaCompositionError('E_HYA_COMPOSITION_CAPABILITY', path, 'Host capability is unavailable.', missing);
      skipped.add(part.id); diagnostics.push({code: 'W_HYA_COMPOSITION_OPTIONAL_SKIPPED', path, capability: missing, part: part.id});
    }
  });
  let changed: boolean;
  do {
    changed = false;
    for (const [i, part] of document.parts.entries()) if (!skipped.has(part.id) && part.dependencies.some(id => skipped.has(id))) {
      if (part.required || isStrict) throw new HyaCompositionError('E_HYA_COMPOSITION_REFERENCE', `$.parts[${i}].dependencies`, 'An active part depends on a skipped part.', part.extension);
      skipped.add(part.id); changed = true;
      diagnostics.push({code: 'W_HYA_COMPOSITION_OPTIONAL_SKIPPED', path: `$.parts[${i}].dependencies`, capability: part.extension, part: part.id});
    }
  } while (changed);
  const byId = new Map(document.parts.map(part => [part.id, part]));
  const add = (part: HyaCompositionPart): void => {
    if (active.has(part.id) || skipped.has(part.id)) return;
    part.dependencies.forEach(id => add(byId.get(id)!)); active.add(part.id);
  };
  document.parts.forEach(add);
  return freezeComposition({document, activeParts: [...active], targets: document.targets.filter(t => active.has(t.part)), diagnostics, complete: diagnostics.length === 0});
}
