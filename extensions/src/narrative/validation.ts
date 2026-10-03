import type { NarrativeCondition, NarrativeDefinition, NarrativeEffect, NarrativeValue, NarrativeVariables } from './types';

export function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path}: expected object`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${path}: expected nonempty string`);
  return value;
}
export function scalar(value: unknown, path: string): NarrativeValue {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new TypeError(`${path}: expected finite number, string or boolean`);
}
export function variables(value: unknown, path: string): Record<string, NarrativeValue> {
  const result: Record<string, NarrativeValue> = Object.create(null);
  for (const [key, entry] of Object.entries(object(value, path))) { text(key, path); result[key] = scalar(entry, `${path}.${key}`); }
  return result;
}
export function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path}: expected array`);
  return value;
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
function variable(key: unknown, vars: NarrativeVariables): string {
  const name = text(key, 'variable');
  if (!Object.hasOwn(vars, name)) throw new TypeError(`Unknown variable: ${name}`);
  return name;
}
function condition(raw: unknown, vars: NarrativeVariables, depth = 0): NarrativeCondition {
  if (depth > 32) throw new TypeError('Condition nesting exceeds 32');
  const c = object(raw, 'condition');
  if (c.op === 'all' || c.op === 'any') return { op: c.op, conditions: array(c.conditions, 'conditions').map(v => condition(v, vars, depth + 1)) };
  if (c.op === 'not') return { op: 'not', condition: condition(c.condition, vars, depth + 1) };
  if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(String(c.op))) throw new TypeError('Unknown condition operator');
  const name = variable(c.variable, vars), value = scalar(c.value, 'condition.value');
  if (typeof value !== typeof vars[name]) throw new TypeError(`Condition type mismatch: ${name}`);
  if (c.op !== 'eq' && c.op !== 'ne' && typeof value !== 'number') throw new TypeError('Ordered comparisons require numbers');
  return { op: c.op as 'eq', variable: name, value };
}
function effects(raw: unknown, vars: NarrativeVariables): NarrativeEffect[] {
  return array(raw, 'effects').map(v => {
    const e = object(v, 'effect'), name = variable(e.variable, vars), value = scalar(e.value, 'effect.value');
    if (e.op === 'set' && typeof value === typeof vars[name]) return { op: 'set', variable: name, value };
    if (e.op === 'add' && typeof value === 'number' && typeof vars[name] === 'number') return { op: 'add', variable: name, value };
    throw new TypeError(`Invalid effect or type: ${name}`);
  });
}
/** Validate references/operators and copy only supported fields; never evaluate expressions or scripts. */
export function validateNarrativeDefinition(raw: unknown): NarrativeDefinition {
  const d = object(raw, 'story');
  if (d.schemaVersion !== 1) throw new TypeError('Unsupported story schemaVersion');
  const vars = variables(d.variables, 'variables'), rawNodes = object(d.nodes, 'nodes');
  const nodes: Record<string, NarrativeDefinition['nodes'][string]> = Object.create(null);
  const target = (v: unknown) => { const id = text(v, 'target'); if (!Object.hasOwn(rawNodes, id)) throw new TypeError(`Unknown target: ${id}`); return id; };
  for (const [id, rawNode] of Object.entries(rawNodes)) {
    text(id, 'node id'); const n = object(rawNode, id);
    if (n.type === 'branch') nodes[id] = { type: 'branch', condition: condition(n.condition, vars), then: target(n.then), otherwise: target(n.otherwise) };
    else if (n.type === 'effect') nodes[id] = { type: 'effect', effects: effects(n.effects, vars), next: target(n.next) };
    else if (n.type === 'action') nodes[id] = { type: 'action', name: text(n.name, 'action.name'), next: target(n.next), ...(n.payload === undefined ? {} : { payload: variables(n.payload, 'payload') }), ...(n.textKey === undefined ? {} : { textKey: text(n.textKey, 'textKey') }) };
    else if (n.type === 'dialogue' || n.type === 'choice' || n.type === 'end') {
      const presentation = { textKey: text(n.textKey, 'textKey'), ...(n.speakerKey === undefined ? {} : { speakerKey: text(n.speakerKey, 'speakerKey') }), ...(n.artwork === undefined ? {} : { artwork: { assetKey: text(object(n.artwork, 'artwork').assetKey, 'assetKey'), textKey: text(object(n.artwork, 'artwork').textKey, 'textKey') } }) };
      if (n.type === 'dialogue') nodes[id] = { ...presentation, type: 'dialogue', next: target(n.next) };
      else if (n.type === 'end') nodes[id] = { ...presentation, type: 'end', ending: text(n.ending, 'ending') };
      else {
        const ids = new Set<string>();
        const options = array(n.options, 'options').map(rawOption => {
          const o = object(rawOption, 'option'), optionId = text(o.id, 'option id');
          if (ids.has(optionId)) throw new TypeError(`Duplicate option: ${optionId}`); ids.add(optionId);
          return { id: optionId, textKey: text(o.textKey, 'option.textKey'), next: target(o.next), ...(o.visibleWhen === undefined ? {} : { visibleWhen: condition(o.visibleWhen, vars) }), ...(o.enabledWhen === undefined ? {} : { enabledWhen: condition(o.enabledWhen, vars) }), ...(o.effects === undefined ? {} : { effects: effects(o.effects, vars) }) };
        });
        if (!options.length) throw new TypeError('Choice requires options');
        nodes[id] = { ...presentation, type: 'choice', options };
      }
    } else throw new TypeError(`Unknown node type: ${String(n.type)}`);
  }
  return deepFreeze({ schemaVersion: 1, id: text(d.id, 'story.id'), version: text(d.version, 'story.version'), start: target(d.start), variables: vars, nodes });
}
export function matches(c: NarrativeCondition, vars: NarrativeVariables): boolean {
  if (c.op === 'all') return c.conditions.every(v => matches(v, vars));
  if (c.op === 'any') return c.conditions.some(v => matches(v, vars));
  if (c.op === 'not') return !matches(c.condition, vars);
  if (!('variable' in c)) return false;
  const value = vars[c.variable];
  switch (c.op) {
    case 'eq': return value === c.value;
    case 'ne': return value !== c.value;
    case 'gt': return (value as number) > (c.value as number);
    case 'gte': return (value as number) >= (c.value as number);
    case 'lt': return (value as number) < (c.value as number);
    case 'lte': return (value as number) <= (c.value as number);
  }
}
