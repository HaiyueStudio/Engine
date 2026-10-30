import type {Entity} from '@haiyue/engine';
import type {AssetManager} from '@haiyue/engine/assets';
import type {AnimationComponent, AnimationVectorShapeComponent, ParsedAnimation} from '@haiyue/animation-spec';
import {Animation2DStateMachineVisualRuntime} from '../Animation2DStateMachineVisualRuntime.js';
import type {Animation2DRuntimeNode, Animation2DRuntimeVisual, AnimationCoreResourceKind, Animation2DCoreResourcePort, DeferredCoreVisual} from '../Animation2DRuntime.js';
import type {Animation2DExtensionRegistry} from '../Animation2DExtensionRegistry.js';
import type {AnimationStateTextDocument} from '../AnimationTextRasterizer.js';
import type {Animation2DPose, Animation2DPoseChannel} from '../runtime/mixer/index.js';
import type {RuntimeChannel, StateMachinePose} from '../../hya-state-machine/v2/runtime-types.js';
import {ProductionFrameError} from './FrameTransaction.js';
import {ProductionCoreResources} from './ProductionCoreResources.js';
import {productionStrokeCoverage} from './ProductionStrokeCoverage.js';

const coreResourceOwners = new WeakMap<ProductionCoreStateVisualRuntime, ProductionCoreResources>();
function resources(runtime: ProductionCoreStateVisualRuntime): ProductionCoreResources {let owner = coreResourceOwners.get(runtime); if (!owner) {owner = new ProductionCoreResources(); coreResourceOwners.set(runtime, owner);} return owner;}
type Color = readonly [number, number, number, number];
type Path = 'paint.fill.color' | 'paint.stroke.color' | 'paint.stroke.width' | 'paint.opacity'
  | 'text.value' | 'text.fontSize' | 'text.tracking' | 'text.color' | 'text.opacity';
interface AuthoredNode {readonly x: number; readonly y: number; readonly rotation: number; readonly scaleX: number; readonly scaleY: number; readonly opacity: number; readonly disabled: boolean;}
interface Style {fill?: Color; stroke?: Color; width?: number; opacity?: number; text?: AnimationStateTextDocument;}
interface Binding {node: string; index: number; path: Path;}
const pattern = /^components\.(0|[1-9]\d*)\.(paint\.fill\.color|paint\.stroke\.color|paint\.stroke\.width|paint\.opacity|text\.value|text\.fontSize|text\.tracking|text\.color|text\.opacity)$/u;
const fail = (path: string, message: string): never => {throw new ProductionFrameError('E_HYA_RUNTIME_BINDING', path, message);};
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const key = (node: string, index: number) => JSON.stringify([node, index]);

/** Production-only nine-path admission. The old state visual entry and registry are unchanged. */
export class ProductionCoreStateVisualRuntime extends Animation2DStateMachineVisualRuntime {
  private readonly channels: ReadonlyMap<string, RuntimeChannel>;
  private readonly managed = new Set<string>();
  private readonly styles = new Map<string, {signature: string; width: number | undefined}>();
  private readonly dynamic = new WeakMap<object, boolean>();
  private readonly baseAlphaGate = new WeakMap<object, number>();
  private readonly timeDependent: boolean;
  private readonly _hasAuthoredTracks: boolean;
  private readonly _authoredDuration: number;
  private readonly additionalPaints: number;
  private readonly authoredNodes = new Map<Animation2DRuntimeNode, AuthoredNode>();
  private readonly authoredUvRects = new Map<Animation2DRuntimeVisual, readonly [number, number, number, number]>();
  private authoredKey: string | undefined;
  private authoredEvaluations = 0;
  private previousComponentKey = '[]';
  private productionDisposed = false;
  private lastVisualKey: string | undefined;
  private productionSequence = 0;
  constructor(owner: Entity, animation: ParsedAnimation, channels: readonly RuntimeChannel[], extensions?: Animation2DExtensionRegistry, assets?: AssetManager, coreResources?: Animation2DCoreResourcePort) {
    validateProductionCoreChannels(animation, channels);
    super(owner, animation, extensions, assets, coreResources); this.channels = new Map(channels.map(channel => [channel.id, channel]));
    this._hasAuthoredTracks = animation.tracks.length > 0; this._authoredDuration = animation.duration;
    this.timeDependent = animation.nodes.some(node => (node.components ?? []).some(animated));
    this.additionalPaints = animation.nodes.reduce((count, node) => count + (node.components ?? []).filter(component => component.type === 'org.haiyue.vector-shape@1' && component.fill && component.stroke).length, 0);
    for (const node of animation.nodes) for (const [index, component] of (node.components ?? []).entries()) if (component.type === 'org.haiyue.vector-stroke@1' || component.type === 'org.haiyue.vector-shape@1' && component.stroke) this.managed.add(key(node.id, index));
  }
  protected override _coreResourceStarted(kind: AnimationCoreResourceKind, id: string): () => void {return resources(this).begin(kind, id);}
  protected override _coreResourceFailed(kind: AnimationCoreResourceKind, id: string, error: unknown, hostMissing = false): void {resources(this).fail(kind, id, error, hostMissing);}
  assertCoreResourcesReady(): void {this.live(); resources(this).assertReady();}
  whenCoreResourcesReady(): Promise<void> {return resources(this).whenReady();}
  setCoreResourceInvalidation(invalidate: (() => void) | undefined): void {this.live(); resources(this).setInvalidation(invalidate);}
  get coreResourceStats() {return resources(this).stats;}
  protected override _materializeCoreVisual(node: Animation2DRuntimeNode, deferred: DeferredCoreVisual): void {
    // Inline legacy strokes use the source object as their geometry-cache key.
    // Production state writes must never mutate another instance's shared cache entry.
    const owned = deferred.component.type === 'org.haiyue.vector-stroke@1' ? {...deferred, component: {...deferred.component}} : deferred;
    super._materializeCoreVisual(node, owned);
    if (deferred.component.type === 'org.haiyue.vector-shape@1' && deferred.component.fill && deferred.component.stroke) {
      const {fill: _fill, ...stroke} = deferred.component;
      super._materializeCoreVisual(node, {...deferred, component: stroke, order: deferred.order + .5});
    }
    // State visibility can materialize an authored-inactive sprite after timeline sampling.
    // Keep that initial UV before the first component pose can mutate it.
    if (this.authoredNodes?.size) for (const visual of node.visuals) if (!this.authoredUvRects.has(visual))
      this.authoredUvRects.set(visual, Object.freeze([...visual.component.uvRect]) as readonly [number, number, number, number]);
  }
  /** Samples the original core timeline, then overlays original mixed state values without resetting authored motion.
   * This visual executor does not own timeline particle/audio side effects or extension callbacks; the
   * composition owner must route them through their transactional owners before admitting those sources.
   */
  applyAuthoredMixedChannels(channels: StateMachinePose['channels'], time: number): void {
    this.live();
    if (!Number.isFinite(time) || time < 0) fail('$.time', 'core visual time must be finite and non-negative');
    for (const node of this._nodes) if (node.particles.length || node.audio.length || node.extensions.length)
      throw new ProductionFrameError('E_HYA_RUNTIME_CAPABILITY', '$.core.nodes[' + JSON.stringify(node.source.id) + ']', 'timeline side effects and extension callbacks need their composition owner');
    const componentKey = JSON.stringify(channels.filter(entry => entry.value !== null && entry.channel.path.startsWith('components.') && !pattern.test(entry.channel.path))
      .map(entry => [entry.channel.id, entry.channel.path, entry.value]));
    const componentWrites = componentKey !== '[]' || this.previousComponentKey !== '[]';
    const key = JSON.stringify([this.timeDependent || this._hasAuthoredTracks ? time : 0, this._nodes.map(node => {
      const start = node.source.start ?? 0; return time < start || time > start + (node.source.duration ?? this._authoredDuration);
    })]);
    if (key !== this.authoredKey || componentKey !== this.previousComponentKey) {
      // Legacy component pose writes mutate the visual; invalidate the original sampler's cursors so
      // releasing an override at the same authored time restores its UV/morph, rather than keeping state.
      if (componentWrites) for (const node of this._nodes) {
        const restored = new Set<number>();
        for (const visual of node.visuals) {
          const uv = this.authoredUvRects.get(visual); if (uv) visual.component.setUvRect(uv);
          if (visual.pathMorph) visual.lastMorphTime = Number.NaN;
          if (visual.vectorShape) {
            // A static vector has no authored morph track to invalidate. Rebuild its base through
            // the existing updater too, otherwise releasing a state morph leaves its geometry behind.
            if (!restored.has(visual.sourceComponentIndex)) {
              restored.add(visual.sourceComponentIndex);
              this._applyProductionVisualStyle(node, visual.sourceComponentIndex, node.source.components![visual.sourceComponentIndex]!, time, true, undefined, undefined, productionStrokeCoverage);
            }
            visual.lastVectorTime = Number.NaN;
          }
          if (visual.spriteUvRectTrack) visual.spriteUvRectFrame = -1;
        }
      }
      super.apply(time, false, 1);
      this.authoredNodes.clear();
      for (const node of this._nodes) {
        this.authoredNodes.set(node, Object.freeze({x: node.transform.x, y: node.transform.y, rotation: node.transform.rotation,
          scaleX: node.transform.scaleX, scaleY: node.transform.scaleY, opacity: node.opacity, disabled: node.entity.disabled}));
        for (const visual of node.visuals) this.baseAlphaGate.set(visual, visual.lastAlpha);
        for (const visual of node.visuals) this.authoredUvRects.set(visual, Object.freeze([...visual.component.uvRect]) as readonly [number, number, number, number]);
      }
      this.authoredKey = key; this.authoredEvaluations++; this.styles.clear(); this.lastVisualKey = undefined;
    }
    this.applyMixedChannels(channels, time); this.previousComponentKey = componentKey;
  }
  protected override _resetPoseNode(node: Animation2DRuntimeNode): void {
    const base = this.authoredNodes.get(node); if (!base) {super._resetPoseNode(node); return;}
    node.entity.disabled = base.disabled; node.transform.setPosition(base.x, base.y); node.transform.rotation = base.rotation;
    node.transform.setScale(base.scaleX, base.scaleY); node.opacity = base.opacity;
  }
  protected override _poseVisualAlpha(visual: Animation2DRuntimeVisual): number {return this.authoredNodes.size ? visual.styleAlpha : super._poseVisualAlpha(visual);}
  /** Consumes the existing v2 mixer's selected values. It does not sample or mix again. */
  applyMixedChannels(channels: StateMachinePose['channels'], time: number): void {
    this.live();
    const values: Animation2DPoseChannel[] = [], seen = new Set<string>();
    for (const entry of channels) {
      const declared = this.channels.get(entry.channel.id) ?? fail(entry.channel.id, 'mixed channel is not declared by this core binding owner');
      if (declared.target !== entry.channel.target || declared.path !== entry.channel.path) fail(entry.channel.id, 'mixed channel is not declared by this core binding owner');
      const id = key(declared.target, 0) + '/' + declared.path;
      if (seen.has(id)) fail(declared.id, 'independent mixed poses overlap the same core property'); seen.add(id);
      if (entry.value === null) continue;
      values.push({binding: {id: declared.id, targetId: declared.target, path: declared.path, strategy: declared.policy === 'discrete' ? 'discrete' : 'continuous'},
        value: Array.isArray(entry.value) ? new Float32Array(entry.value) : typeof entry.value === 'number' ? new Float32Array([entry.value]) : entry.value});
    }
    if (!Number.isSafeInteger(this.productionSequence + 1)) throw new ProductionFrameError('E_HYA_RUNTIME_LIMIT', '$.sequence', 'production core sequence exhausted');
    this.applyPose({sequence: ++this.productionSequence, mixerTime: time, channels: values, effects: []});
  }
  override applyPose(pose: Animation2DPose, playing = false, speed = 1): void {
    this.live();
    if (!Number.isFinite(pose.mixerTime) || pose.mixerTime < 0) fail('$.time', 'core visual time must be finite and non-negative');
    const selected = new Map<string, Style>(), ordinary: Animation2DPoseChannel[] = [], morphs = new Map<string, Float32Array>();
    // Validate the entire style set before any original entity, texture or geometry is changed.
    for (const channel of pose.channels) {
      if (!pattern.test(channel.binding.path)) {ordinary.push(channel);const m = /^components\.(\d+)\.vector\.morph$/u.exec(channel.binding.path);if (m && channel.value instanceof Float32Array) morphs.set(key(channel.binding.targetId, Number(m[1])), channel.value);continue;}
      const binding = parse(channel.binding.targetId, channel.binding.path), node = this._nodesById.get(binding.node);
      validateTarget(node?.source.components?.[binding.index], binding.path, channel.binding.id);
      const value = normalized(binding.path, channel.value, channel.binding.id), id = key(binding.node, binding.index), style = selected.get(id) ?? {};
      if (binding.path === 'paint.fill.color') style.fill = value as Color;
      else if (binding.path === 'paint.stroke.color') style.stroke = value as Color;
      else if (binding.path === 'paint.stroke.width') style.width = value as number;
      else if (binding.path.endsWith('.opacity')) style.opacity = value as number;
      else style.text = {...style.text, [binding.path.slice(5)]: value};
      selected.set(id, style);
    }
    const visualKey = JSON.stringify([pose.channels.map(channel => [channel.binding, channel.value instanceof Float32Array ? [...channel.value] : channel.value]), this.timeDependent ? pose.mixerTime : 0, playing, speed]);
    if (!pose.effects.length && visualKey === this.lastVisualKey) return;
    for (const node of this._nodes) for (const visual of node.visuals) visual.lastAlpha = this.baseAlphaGate.get(visual) ?? visual.lastAlpha;
    super.applyPose({...pose, channels: ordinary}, playing, speed);
    for (const id of selected.keys()) this.managed.add(id);
    for (const node of this._nodes) for (const index of new Set(node.visuals.map(visual => visual.sourceComponentIndex))) {
      const id = key(node.source.id, index); if (!this.managed.has(id)) continue;
      const style = selected.get(id) ?? {}, source = node.source.components![index]!, previous = this.styles.get(id), morph = morphs.get(id);
      const dynamic = this.dynamic.get(source) ?? animated(source); this.dynamic.set(source, dynamic);
      const signature = JSON.stringify([style, dynamic ? pose.mixerTime : 0, morph ? [...morph] : null]);
      if (previous?.signature !== signature) {
        this._applyProductionVisualStyle(node, index, componentWithStyle(source, style), pose.mixerTime, previous === undefined || previous.width !== style.width, morph, style.text, productionStrokeCoverage);
        this.styles.set(id, {signature, width: style.width});
      } else if (source.type === 'text2d') for (const visual of node.visuals.filter(visual => visual.sourceComponentIndex === index)) visual.textRasterizer!.setTime(pose.mixerTime);
      this.alpha(node, index, style.opacity ?? 1);
    }
    for (const node of this._nodes) for (const visual of node.visuals) this.baseAlphaGate.set(visual, visual.baseAlpha * this._resolveOpacity(node));
    this.lastVisualKey = visualKey;
  }
  async whenTextReady(): Promise<void> {await Promise.all(this._nodes.flatMap(node => node.visuals.flatMap(visual => visual.textRasterizer ? [visual.textRasterizer.whenReady()] : [])));}
  override get stats() {const stats = super.stats;return Object.freeze({...stats, visualCount: stats.visualCount + this.additionalPaints, authoredEvaluations: this.authoredEvaluations});}
  override destroy(): void {resources(this).dispose(); this.productionDisposed = true; this.authoredUvRects.clear(); this.authoredNodes.clear(); this.styles.clear(); this.managed.clear(); super.destroy();}
  private live(): void {if (this.productionDisposed) throw new ProductionFrameError('E_HYA_RUNTIME_DISPOSED', '$.core', 'production core visual runtime is disposed');}
  private alpha(node: Animation2DRuntimeNode, index: number, opacity: number): void {
    for (const visual of node.visuals.filter(visual => visual.sourceComponentIndex === index)) {
      const alpha = visual.styleAlpha * this._resolveOpacity(node) * opacity;
      if (visual.color[3] !== alpha) {visual.color[3] = alpha; visual.component.revision++;} visual.lastAlpha = alpha;
    }
  }
}
function parse(node: string, path: string): Binding {const match = pattern.exec(path);if (!match || !Number.isSafeInteger(Number(match[1]))) return fail(path, 'style path has an invalid component index');return {node, index: Number(match[1]), path: match[2] as Path};}
function validateTarget(component: Readonly<AnimationComponent> | undefined, path: Path, id: string): void {
  if (!component) return fail(id, 'core style target component is absent');
  const vector = component.type === 'org.haiyue.vector-shape@1' ? component as AnimationVectorShapeComponent : undefined;
  if (path.startsWith('text.')) {if (component.type !== 'text2d') fail(id, 'text style requires a text2d component');return;}
  if (path === 'paint.fill.color') {if (!(component.type === 'shape2d' || component.type === 'path2d' || vector?.fill?.kind === 'solid')) fail(id, 'fill color requires a solid fill target');}
  else if (path.startsWith('paint.stroke.')) {if (!(component.type === 'org.haiyue.vector-stroke@1' || vector?.stroke) || path.endsWith('.color') && vector?.stroke?.gradient) fail(id, 'stroke style requires an active solid stroke target');}
  else if (!['shape2d', 'path2d', 'org.haiyue.vector-shape@1', 'org.haiyue.vector-stroke@1'].includes(component.type)) fail(id, 'paint opacity requires a drawable paint component');
}
function normalized(path: Path, value: unknown, id: string): string | number | Color {
  if (path === 'text.value') {if (typeof value !== 'string') return fail(id, 'text value requires a string');return value;}
  const vector = value instanceof Float32Array || Array.isArray(value) ? Array.from(value as ArrayLike<number>) : undefined;
  if (path.endsWith('.color')) {if (!vector || vector.length !== 4 || vector.some(n => typeof n !== 'number' || !Number.isFinite(n))) return fail(id, 'paint color requires four finite channels');return Object.freeze(vector.map(clamp)) as unknown as Color;}
  const number = vector?.length === 1 ? vector[0] : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || path.endsWith('.fontSize') && number <= 0 || path.endsWith('.width') && number < 0) return fail(id, 'style metric is outside its admitted finite range');
  return path.endsWith('.opacity') ? clamp(number) : number;
}
function componentWithStyle(source: Readonly<AnimationComponent>, style: Style): Readonly<AnimationComponent> {
  if (source.type === 'org.haiyue.vector-shape@1') {
    const shape = source as AnimationVectorShapeComponent;
    const fill = shape.fill && style.fill ? {...shape.fill, color: style.fill} : shape.fill;
    if (fill && style.fill) delete (fill as {colorTrack?: unknown}).colorTrack;
    const stroke = shape.stroke && (style.stroke || style.width !== undefined) ? {...shape.stroke, ...(style.stroke ? {color: style.stroke} : {}), ...(style.width === undefined ? {} : {width: style.width})} : shape.stroke;
    if (stroke && style.stroke) delete (stroke as {colorTrack?: unknown}).colorTrack;
    if (stroke && style.width !== undefined) delete (stroke as {widthTrack?: unknown}).widthTrack;
    return {...shape, ...(fill ? {fill} : {}), ...(stroke ? {stroke} : {})};
  }
  if ((source.type === 'shape2d' || source.type === 'path2d') && style.fill) return {...source, fill: style.fill};
  if (source.type === 'org.haiyue.vector-stroke@1') return {...source, ...(style.stroke ? {color: style.stroke} : {}), ...(style.width === undefined ? {} : {width: style.width})};
  return source;
}
function animated(value: unknown): boolean {if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return false;return Object.entries(value).some(([name, child]) => name === 'morph' || name.endsWith('Track') || name === 'documents' || name === 'animators' || name === 'expression' || animated(child));}

/** Pure preflight shared by the composition compiler and the original visual owner. */
export function validateProductionCoreChannels(animation: ParsedAnimation, channels: readonly RuntimeChannel[]): void {
    const nodes = new Map(animation.nodes.map(node => [node.id, node]));
    const properties = new Set<string>();
    for (const channel of channels) if (pattern.test(channel.path)) {
      const binding = parse(channel.target, channel.path), component = nodes.get(binding.node)?.components?.[binding.index];
      const property = JSON.stringify([channel.target, channel.path]);if (properties.has(property)) fail(channel.id, 'multiple declared channels target the same core style property');properties.add(property);
      validateTarget(component, binding.path, channel.id);
      const text = binding.path.startsWith('text.'), color = binding.path.endsWith('.color'), string = binding.path === 'text.value';
      if (channel.family !== (text ? 'text-layout' : 'paint-path') || channel.valueKind !== (string ? 'string' : color ? 'color' : 'number')
        || string && channel.policy !== 'discrete' || !string && !['override', 'additive'].includes(channel.policy) || color && channel.valueSize !== 4)
        fail(channel.id, 'state style family, policy, kind or numeric width does not match its admitted target');
      if (channel.defaultValue !== undefined && channel.defaultValue !== null) normalized(binding.path, channel.defaultValue, channel.id);
    } else if (/^(?:components\.[^.]+\.(?:paint|text|effects?|composite)|(?:paint|text|effect|composite)\.)/u.test(channel.path))
      throw new ProductionFrameError('E_STATE_MACHINE_CHANNEL_ADVANCED_INLINE_UNSUPPORTED', channel.path, 'only the nine production style paths are admitted');
    if (new Set(channels.map(channel => channel.id)).size !== channels.length) fail('$.channels', 'duplicate core state channel ID');
}
