import { validateNarrativeDefinition } from '../../narrative/validation';
import { at, fields, items, label, read, reject, stableId } from './data';
import type { NarrativeNode } from '../../narrative/types';
import type { StorySource } from './types';

export const STAGE_ACTION = 'visualNovel.stage';

export function nodeId(raw: unknown, chapter: string, site: StorySource): string {
  const value = label(raw, site);
  const segments = value.split('/');
  if (segments.length > 2) reject(site, 'invalid-node-reference', 'Expected node or chapter/node.');
  segments.forEach(segment => stableId(segment, site));
  if (segments.length === 2) return value;
  if (!chapter) reject(site, 'unqualified-node', 'Expected a qualified chapter/node reference.');
  return `${chapter}/${value}`;
}

const presentation = ['textKey', 'speakerKey', 'artwork', 'lineId', 'voices'];
const nodeFields: Readonly<Record<string, readonly string[]>> = {
  dialogue: [...presentation, 'next'],
  choice: [...presentation, 'options'],
  end: [...presentation, 'ending'],
  branch: ['condition', 'then', 'otherwise'],
  effect: ['effects', 'next'],
  action: ['name', 'next', 'payload', 'textKey', 'lineId', 'voices'],
  stage: ['cues', 'next'],
};

/** Lower jump syntax, then use the existing narrative validator for semantics and its canonical result. */
export function readNode(
  id: string,
  chapter: string,
  raw: unknown,
  source: StorySource,
  nodes: ReadonlySet<string>,
  actions: ReadonlySet<string>,
  variables: object,
): { narrative: NarrativeNode; author: Record<string, unknown> } {
  const author = fields(raw, source);
  const type = author.type;
  if (typeof type !== 'string' || !Object.hasOwn(nodeFields, type)) {
    reject(at(source, 'type'), 'invalid-node-kind', 'Unknown story node type.');
  }
  fields(author, source, ['type', ...nodeFields[type]!]);
  const draft = { ...author };
  const dependencies: Record<string, object> = Object.create(null);
  const jump = (value: unknown, site: StorySource) => {
    const target = nodeId(value, chapter, site);
    if (!nodes.has(target)) reject(site, 'unknown-target', `Unknown target "${target}".`);
    dependencies[target] = { type: 'end', ending: 'validation', textKey: 'validation' };
    return target;
  };
  if (type === 'dialogue' || type === 'effect' || type === 'stage' || type === 'action') {
    draft.next = jump(author.next, at(source, 'next'));
  }
  if (type === 'branch') {
    draft.then = jump(author.then, at(source, 'then'));
    draft.otherwise = jump(author.otherwise, at(source, 'otherwise'));
  }
  if (type === 'choice') {
    const ids = new Set<string>();
    draft.options = items(author.options, at(source, 'options')).map((item, index) => {
      const site = at(source, 'options', index);
      const option = fields(item, site, ['id', 'textKey', 'next', 'visibleWhen', 'enabledWhen', 'effects']);
      const choiceId = stableId(option.id, at(site, 'id'));
      if (ids.has(choiceId)) reject(at(site, 'id'), 'duplicate-choice', `Duplicate choice "${choiceId}" within node "${id}".`);
      ids.add(choiceId);
      return { ...option, next: jump(option.next, at(site, 'next')) };
    });
  }
  if (type === 'stage') {
    draft.type = 'action';
    draft.name = STAGE_ACTION;
  } else if (type === 'action') {
    const name = label(author.name, at(source, 'name'));
    if (!actions.has(name)) reject(at(source, 'name'), 'undeclared-action', `Action "${name}" must be declared in project actions.`);
  } else if (type === 'end') {
    stableId(author.ending, at(source, 'ending'));
  }
  dependencies[id] = draft;
  const { nodes: checked } = read(source, () => validateNarrativeDefinition({
    schemaVersion: 1, id: 'authoring', version: 'validation', start: id, variables, nodes: dependencies,
  }));
  return { narrative: checked[id]!, author };
}

export function successors(node: NarrativeNode): readonly string[] {
  switch (node.type) {
    case 'end': return [];
    case 'branch': return [node.then, node.otherwise];
    case 'choice': return node.options.map(option => option.next);
    default: return [node.next];
  }
}

export function reachableFrom(start: string, nodes: Readonly<Record<string, NarrativeNode>>): Set<string> {
  const visited = new Set([start]);
  for (const id of visited) for (const next of successors(nodes[id]!)) visited.add(next);
  return visited;
}

/** Remove every automatic node with a structural escape, then propagate that escape backwards. */
export function closedAutomaticNodes(nodes: Readonly<Record<string, NarrativeNode>>): Set<string> {
  const automatic = Object.keys(nodes).filter(id => nodes[id]?.type === 'branch' || nodes[id]?.type === 'effect');
  const closed = new Set(automatic);
  const incoming = new Map<string, string[]>();
  const escaped = new Set<string>();
  for (const id of automatic) {
    for (const target of successors(nodes[id]!)) {
      if (!closed.has(target)) escaped.add(id);
      else {
        const sources = incoming.get(target) ?? [];
        sources.push(id);
        incoming.set(target, sources);
      }
    }
  }
  for (const id of escaped) {
    closed.delete(id);
    for (const source of incoming.get(id) ?? []) escaped.add(source);
  }
  return closed;
}
