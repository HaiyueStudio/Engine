import type {ParsedAnimation} from '@haiyue/animation-spec';
import type {RuntimeChannel, RuntimeValue, StateMachinePose, RuntimeDocument} from '../../hya-state-machine/v2/runtime-types.js';
import {validateProductionCoreChannels} from './ProductionCoreStateVisualRuntime.js';
import {ProductionFrameError} from './FrameTransaction.js';

export interface CoreDataLink {readonly data: string; readonly binding: string; readonly target: string; readonly path: readonly string[];}
interface CoreTarget {readonly id: string; readonly part: string; readonly kind: string; readonly address: readonly string[];}
interface CoreStateSource {readonly id: string; readonly dependencies: readonly string[]; readonly document: RuntimeDocument;}
function fail(path: string, message: string): never {throw new ProductionFrameError('E_HYA_RUNTIME_BINDING', path, message);}

/** Compiles aliases once; original data converters and state mixer remain the only value evaluators. */
export class ProductionCoreBindingPlan {
  readonly channels: readonly RuntimeChannel[];
  private readonly data: readonly {link: CoreDataLink; channel: RuntimeChannel}[];
  private readonly states = new Map<string, ReadonlyMap<string, RuntimeChannel>>();
  constructor(readonly part: string, animation: ParsedAnimation, targets: readonly CoreTarget[], links: readonly CoreDataLink[], sources: readonly CoreStateSource[]) {
    const aliases = new Map(targets.filter(target => target.part === part && target.kind === 'animation-node').map(target => [target.id, target.address[0]!]));
    const properties = new Map<string, RuntimeChannel>();
    const canonical = (target: string, path: string, source: string): RuntimeChannel => {
      if (!animation.nodes.some(node => node.id === target)) fail(source, 'core node is absent');
      const id = JSON.stringify([part, target, path]); let channel = properties.get(id);
      if (!channel) {channel = Object.freeze({id, target, path, ...shape(path, source)}); properties.set(id, channel);}
      return channel;
    };
    this.data = Object.freeze(links.filter(link => aliases.has(link.target)).map(link => {
      // Data paths are explicit segments. A dotted component/opaque target cannot smuggle a member path.
      const path = link.path.join('.');
      if (link.path.some(segment => !segment || segment.includes('.'))) fail(link.binding, 'core binding requires explicit path segments');
      return Object.freeze({link, channel: canonical(aliases.get(link.target)!, path, link.binding)});
    }));
    const dataProperties = new Set<string>();
    for (const {link, channel} of this.data) {if (dataProperties.has(channel.id)) fail(link.binding, 'independent data bindings overlap one core property'); dataProperties.add(channel.id);}
    for (const source of sources) {
      const map = new Map<string, RuntimeChannel>();
      for (const channel of source.document.channels) {
        if (channel.valueKind === 'callback') continue; // The original effect owner handles callbacks; they are not visual properties.
        const target = aliases.get(channel.target); if (target === undefined) continue;
        if (!source.dependencies.includes(part)) fail(channel.id, 'state core target needs its explicit part dependency');
        const result = canonical(target, channel.path, channel.id);
        if (channel.family !== result.family || channel.valueKind !== result.valueKind || (channel.valueSize ?? 1) !== (result.valueSize ?? 1)
          || ![result.policy, ...(result.policy === 'override' ? ['additive'] : [])].includes(channel.policy)) fail(channel.id, 'state channel schema does not match its core target');
        // Validate original authored defaults before canonicalization drops them.
        validateProductionCoreChannels(animation, [{...channel, target}]); map.set(channel.id, result);
      }
      if (map.size) this.states.set(source.id, map);
    }
    this.channels = Object.freeze([...properties.values()]); validateProductionCoreChannels(animation, this.channels);
  }
  resolve(states: Readonly<Record<string, readonly StateMachinePose[]>>, read: (part: string, binding: string) => unknown): StateMachinePose['channels'] {
    const values = new Map<string, {channel: RuntimeChannel; value: RuntimeValue}>();
    for (const {link, channel} of this.data) values.set(channel.id, {channel, value: value(read(link.data, link.binding), channel)});
    const selected = new Set<string>();
    for (const [part, channels] of this.states) {
      const poses = states[part]; if (!poses) fail(part, 'upstream state pose is absent');
      for (const pose of poses) for (const entry of pose.channels) {
        const channel = channels.get(entry.channel.id); if (!channel || entry.value === null) continue;
        if (selected.has(channel.id)) fail(channel.id, 'independent active states overlap one core property'); selected.add(channel.id);
        values.set(channel.id, {channel, value: value(entry.value, channel)});
      }
    }
    return Object.freeze([...values.values()].map(entry => Object.freeze(entry)));
  }
}
function shape(path: string, source: string): Pick<RuntimeChannel, 'family' | 'valueKind' | 'valueSize' | 'policy'> {
  if (path === 'transform.position' || path === 'transform.scale') return {family: 'transform', valueKind: 'vector', valueSize: 2, policy: 'override'};
  if (path === 'transform.rotation') return {family: 'transform', valueKind: 'number', policy: 'override'};
  if (path === 'opacity') return {family: 'paint-path', valueKind: 'number', policy: 'override'};
  if (path === 'visibility') return {family: 'visibility-order', valueKind: 'boolean', policy: 'discrete'};
  const match = /^components\.(0|[1-9]\d*)\.(paint\.(?:fill\.color|stroke\.color|stroke\.width|opacity)|text\.(?:value|fontSize|tracking|color|opacity))$/u.exec(path);
  if (!match) fail(source, 'core composition target path is not admitted by this binding adapter');
  const property = match[2]!, text = property.startsWith('text.'), string = property === 'text.value', color = property.endsWith('.color');
  return {family: text ? 'text-layout' : 'paint-path', valueKind: string ? 'string' : color ? 'color' : 'number', policy: string ? 'discrete' : 'override', ...(color ? {valueSize: 4} : {})};
}
function value(input: unknown, channel: RuntimeChannel): RuntimeValue {
  if (channel.valueKind === 'boolean' ? typeof input === 'boolean' : channel.valueKind === 'string' ? typeof input === 'string'
    : channel.valueSize ? Array.isArray(input) && input.length === channel.valueSize && input.every(value => typeof value === 'number' && Number.isFinite(value)) : typeof input === 'number' && Number.isFinite(input)) return input as RuntimeValue;
  return fail(channel.id, 'core binding value does not match its compiled kind or numeric width');
}
