import {LayoutEvaluator, type LayoutTextContext, type PreparedLayoutNodeBindings} from '../parameterized/LayoutEvaluator.js';
import type {LayoutEvaluation, LayoutNodePose, LayoutRect, LayoutRuntimeLimits, RuntimeLayoutDocument, RuntimeNode} from '../parameterized/runtime-types.js';
import type {TextBlockPose} from '../../text/parameterized/runtime-types.js';
import type {ProductionTextRequest, ProductionTextResult} from '../../text/production/types.js';
import {snapshotPlainTextData} from '../../text/PlainTextData.js';
import {snapshotTextResult} from '../../text/production/snapshot.js';
import type {ProductionLayoutFrame, ProductionLayoutInstance, ProductionLayoutNode, ProductionLayoutRequest} from './types.js';
import {snapshotLayoutTransform,identityLayoutTransform,layoutRectBounds,type LayoutAffine} from './ProductionLayoutGeometry.js';

export class ProductionLayoutError extends Error {
  override readonly name = 'ProductionLayoutError';
  constructor(readonly code: string, readonly path: string, message: string) {super(`${message} (${path})`);}
}
function fail(code: string, path: string, message: string): never {throw new ProductionLayoutError(code, path, message);}
type PreparedText = {shape(request: ProductionTextRequest): ProductionTextResult};
type Shaped = Readonly<{key: string; result: ProductionTextResult}>;
interface NodeTextCache {measure?: Shaped; arrange?: Shaped;}
type Rect = readonly [number, number, number, number];
type ScopedText = Pick<ProductionTextRequest, 'strings' | 'selections' | 'cursors' | 'styles'>;

/** Reuses the original HYA adapter/core; owns frame publication, not fonts or another box solver. */
export class ProductionLayoutOwner {
  private readonly evaluator: LayoutEvaluator;
  private readonly rootTransforms: ReadonlyMap<string, LayoutAffine>;
  private readonly nodes: ReadonlyMap<string, ReadonlyMap<string, RuntimeNode>>;
  private readonly editableText:boolean;
  private readonly signal: AbortSignal | undefined;
  private readonly validateStyles: ((styles: NonNullable<ProductionLayoutRequest['styles']>) => void) | undefined;
  private readonly resolveText: ((block: string, context: LayoutTextContext) => ScopedText) | undefined;
  private readonly scopedText = new Map<string, ScopedText>();
  private readonly abort = () => this.dispose();
  private disposed = false;
  private evaluating = false;
  private revision = 0;
  private passes = 0;
  private shapes = 0;
  private cached: Readonly<{key: string; frame: ProductionLayoutFrame}> | undefined;
  private textCache = new Map<string, NodeTextCache>();
  private widthHints = new Map<string, number>();
  private hintKey: string | undefined;
  private request: ProductionLayoutRequest | undefined;
  private widths = new Map<string, number>();
  private nextWidths = new Map<string, number>();
  private priorText = new Map<string, NodeTextCache>();
  private nextText = new Map<string, NodeTextCache>();
  private glyphCounts = {measure: 0, arrange: 0};
  private lineCounts = {measure: 0, arrange: 0};
  private frameState: Readonly<{token: object; revision: number; passes: number; cached: ProductionLayoutOwner['cached']; text: Map<string, NodeTextCache>; widths: Map<string, number>; hint: string | undefined}> | undefined;

  constructor(readonly document: RuntimeLayoutDocument, private readonly text?: PreparedText,
    options: Readonly<{editableText?:boolean;signal?: AbortSignal; validateStyles?: (styles: NonNullable<ProductionLayoutRequest['styles']>) => void; resolveText?: (block: string, context: LayoutTextContext) => ScopedText; resolveNode?: (context: LayoutTextContext) => PreparedLayoutNodeBindings; resolveAsset?: (id: string) => string | null}> = {}, limits?: LayoutRuntimeLimits, private readonly part = '') {
    this.editableText=options.editableText??false;
    if (options.signal?.aborted) fail('E_HYA_RUNTIME_ABORTED', '$.signal', 'layout creation was cancelled');
    if (document.artboards.some(board => board.nodes.some(node => node.kind === 'text')) && (!text || typeof text.shape !== 'function'))
      fail('E_HYA_RUNTIME_HOST_PORT', '$.text', 'a prepared text shaper is required for text nodes');
    const roots = document.instances.map((instance,index) => [instance.id,snapshotLayoutTransform(instance.transform,`$.instances[${index}].transform`)] as const);
    this.nodes = new Map(document.artboards.map(board => [board.id, new Map(board.nodes.map(node => [node.id, node]))]));
    this.evaluator = new LayoutEvaluator(document, limits, {evaluate: (block, _updates, context) => this.shape(block, context)}, {maxExpandedNodes: 250_000, stableIds: true, ...(options.resolveAsset ? {resolveAsset: options.resolveAsset} : {}),
      ...(options.resolveNode ? {resolveNode: (context: LayoutTextContext) => {
        const value = snapshotPlainTextData(options.resolveNode!(context), '$.layout.bindings', (path, message, limit) => fail(limit ? 'E_HYA_RUNTIME_LIMIT' : 'E_HYA_RUNTIME_LAYOUT', path, message), {strict: true, maxBytes: 64 * 1024 * 1024}) as PreparedLayoutNodeBindings;
        if (value.itemScope !== undefined && (typeof value.itemScope!=='string'||!value.itemScope) || value.scopes !== undefined && (!isMap(value.scopes) || Object.values(value.scopes).some(ids=>!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id)))
          || value.items !== undefined && !Array.isArray(value.items) || value.inputs !== undefined && !isMap(value.inputs)
          || value.replacement !== undefined && value.replacement !== null && (typeof value.replacement !== 'string' || !this.nodes.has(value.replacement)))
          fail('E_HYA_RUNTIME_LAYOUT', '$.layout.bindings', 'invalid scoped list/component inputs');
        return value;
      }} : {})});
    this.rootTransforms = new Map(roots.map(([id,matrix])=>[this.evaluator.rootKey(id),matrix]));
    this.signal = options.signal; this.signal?.addEventListener('abort', this.abort, {once: true}); this.validateStyles = options.validateStyles; this.resolveText = options.resolveText;
  }

  evaluate(value: ProductionLayoutRequest, bindingRevision?: string): ProductionLayoutFrame {
    this.assertLive();
    if (this.evaluating) fail('E_HYA_RUNTIME_LAYOUT', '$.layout', 'layout cannot recursively enter the same owner');
    if (bindingRevision !== undefined && typeof bindingRevision !== 'string') fail('E_HYA_RUNTIME_LAYOUT', '$.bindings', 'compiled binding revision must be a string');
    const request = this.snapshot(value), bindings = bindingRevision === undefined ? {} : {bindingRevision}, key = JSON.stringify({...request, ...bindings});
    if (this.cached?.key === key) return this.cached.frame;
    if (request.styles) this.validateStyles?.(request.styles);
    const hintKey = JSON.stringify({...request, time: 0, ...bindings});
    if (this.cached && this.hintKey === hintKey && !this.document.artboards.some(board => board.nodes.some(node => node.component))
      && !Object.values(request.scroll ?? {}).some(scroll => scroll.active !== false && scroll.velocity?.some(value => value !== 0))) {
      const frame = Object.freeze({...this.cached.frame, revision: ++this.revision,
        instances: Object.freeze(this.cached.frame.instances.map(instance => Object.freeze({...instance, times: Object.freeze([request.time])})))});
      this.passes = 0; this.cached = Object.freeze({key, frame}); return frame;
    }
    this.evaluating = true; this.request = request;
    this.widths = this.hintKey === hintKey ? this.widthHints : new Map(); this.priorText = this.textCache;
    try {
      const maximum = this.evaluator.limits.maxLayoutPasses;
      let result: LayoutEvaluation | undefined;
      for (let used = 0; used + 2 <= maximum; used += 2) {
        this.assertLive(); this.nextWidths = new Map(); this.nextText = new Map();
        this.glyphCounts = {measure: 0, arrange: 0}; this.lineCounts = {measure: 0, arrange: 0};
        result = this.evaluator.evaluate({...request, ...(this.signal ? {signal: this.signal} : {})});
        this.assertLive();
        if (sameWidths(this.widths, this.nextWidths)) {
          const frame = this.frame(result, this.revision + 1);
          this.assertLive(); this.revision++; this.passes = used + 2;
          this.textCache = this.nextText; this.widthHints = this.nextWidths; this.hintKey = hintKey;
          this.cached = Object.freeze({key, frame}); return frame;
        }
        this.widths = this.nextWidths; this.priorText = this.nextText;
      }
      fail('E_HYA_RUNTIME_LIMIT', '$.layout', 'text/box constraints did not converge within the existing layout pass ceiling');
    } finally {
      this.request = undefined; this.scopedText.clear(); this.widths = new Map(); this.nextWidths = new Map(); this.priorText = new Map(); this.nextText = new Map(); this.evaluating = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.signal?.removeEventListener('abort', this.abort); this.evaluator.dispose();
    this.cached = undefined; this.frameState = undefined; this.textCache.clear(); this.scopedText.clear(); this.widthHints.clear(); this.hintKey = undefined; this.priorText.clear(); this.nextText.clear();
  }
  /** Internal whole-player barrier; font handles remain with the borrowed prepared font owner. */
  captureFrame(): object {
    this.assertLive();
    if (this.evaluating || this.frameState) fail('E_HYA_RUNTIME_LAYOUT', '$.layout.frame', 'layout checkpoint requires an idle owner');
    const token = Object.freeze({});
    this.frameState = {token, revision: this.revision, passes: this.passes, cached: this.cached, text: this.textCache, widths: this.widthHints, hint: this.hintKey};
    return token;
  }
  releaseFrame(token: object): void {this.requireFrame(token); this.frameState = undefined;}
  restoreFrame(token: object): void {
    const frame = this.requireFrame(token);
    this.revision = frame.revision; this.passes = frame.passes; this.cached = frame.cached;
    this.textCache = frame.text; this.widthHints = frame.widths; this.hintKey = frame.hint; this.frameState = undefined;
  }
  private requireFrame(token: object): NonNullable<ProductionLayoutOwner['frameState']> {
    this.assertLive();
    if (this.evaluating || !this.frameState || this.frameState.token !== token) fail('E_HYA_RUNTIME_LAYOUT', '$.layout.frame', 'layout checkpoint identity does not match');
    return this.frameState;
  }
  get stats(): Readonly<{revision: number; layoutPasses: number; shapes: number; cachedTextNodes: number; disposed: boolean}> {
    return Object.freeze({revision: this.revision, layoutPasses: this.passes, shapes: this.shapes, cachedTextNodes: this.textCache.size, disposed: this.disposed});
  }

  private shape(block: string, context: LayoutTextContext | undefined): TextBlockPose {
    this.assertLive();
    if (!context || !this.request || !this.text) fail('E_HYA_RUNTIME_HOST_PORT', '$.text', 'instance-scoped prepared text is required');
    const id = this.evaluator.nodeKey(context.instanceId, context.node.id), phase = context.phase;
    if (!this.scopedText.has(id)) {
      const scoped = snapshotPlainTextData(this.resolveText?.(block, context) ?? {}, '$.layout.bindings', (path, message, limit) => fail(limit ? 'E_HYA_RUNTIME_LIMIT' : 'E_HYA_RUNTIME_LAYOUT', path, message), {strict: true, maxBytes: 64 * 1024 * 1024}) as ScopedText;
      if (scoped.styles) this.validateStyles?.(scoped.styles); this.scopedText.set(id, scoped);
    }
    const scoped = this.scopedText.get(id)!;
    const strings = {...this.request.strings, ...scoped.strings}, selections = {...this.request.selections, ...scoped.selections}, cursors = {...this.request.cursors, ...scoped.cursors};
    const styles = {...this.request.styles, ...scoped.styles};
    for (const [key, style] of Object.entries(scoped.styles ?? {})) styles[key] = {...this.request.styles?.[key], ...style};
    const width = phase === 'arrange' ? context.rect!.width : this.widths.get(id);
    const request: ProductionTextRequest = {block,...(this.editableText&&this.document.textBlocks.find(b=>b.id===block)?.input?{editingViewport:true}:{}), dpr: this.request.dpr,
      ...(phase === 'arrange' ? {rasterOrigin: [context.rect!.x, context.rect!.y] as const} : {}),
      ...(Object.keys(strings).length ? {strings} : {}), ...(Object.keys(selections).length ? {selections} : {}),
      ...(Object.keys(cursors).length ? {cursors} : {}), ...(Object.keys(styles).length ? {styles} : {}),
      constraints: {width: width === undefined ? {mode: 'unbounded'} : {mode: 'exact', value: width},
        height: phase === 'arrange' ? {mode: 'exact', value: context.rect!.height} : {mode: 'unbounded'}}};
    const key = JSON.stringify(request), previous = this.priorText.get(id)?.[phase];
    let shaped: Shaped;
    if (previous?.key === key) shaped = previous;
    else {
      const result = this.text.shape(request); this.assertLive();
      shaped = Object.freeze({key, result: snapshotTextResult(result, request, this.document)}); this.shapes++;
    }
    const result = shaped.result;
    this.glyphCounts[phase] += result.runs.reduce((count, run) => count + run.glyphs.length, 0);
    this.lineCounts[phase] += result.lines.length;
    if (this.glyphCounts[phase] > this.evaluator.limits.maxGlyphs || this.lineCounts[phase] > this.evaluator.limits.maxLines)
      fail('E_HYA_RUNTIME_LIMIT', '$.layout.text', 'expanded text exceeds the existing glyph/line ceilings');
    const entry = this.nextText.get(id) ?? {}; entry[phase] = shaped; this.nextText.set(id, entry);
    if (phase === 'arrange') this.nextWidths.set(id, context.rect!.width);
    // Only metrics cross back into the legacy evaluator. Real paint is retained separately,
    // without lossy conversion through its diagnostic glyph rectangles.
    return Object.freeze({id: block, width: result.size[0], height: result.size[1], contentWidth: result.contentSize[0], contentHeight: result.contentSize[1], glyphs: Object.freeze([]), lines: Object.freeze([]), controls: Object.freeze([])});
  }

  private frame(layout: LayoutEvaluation, revision: number): ProductionLayoutFrame {
    const instances = new Map(layout.instances.map(instance => [instance.id, instance]));
    // The evaluator expands parents before children. Every descendant shares its root matrix;
    // nested fitted rectangles already include component/list placement and must not be transformed twice.
    const transforms = new Map<string,LayoutAffine>();
    for (const instance of layout.instances) {
      const matrix = instance.parentId ? transforms.get(instance.parentId) : this.rootTransforms.get(instance.id);
      if (!matrix) fail('E_HYA_RUNTIME_LAYOUT','$.layout.instances','expanded instance has no root transform');
      layoutRectBounds(rect(instance.rect),matrix); transforms.set(instance.id,matrix);
    }
    const byKey = new Map<string, ProductionLayoutNode>(), result: ProductionLayoutNode[] = [];
    for (const pose of layout.nodes) {
      const node = this.nodes.get(pose.artboardId)?.get(pose.nodeId);
      if (!node || byKey.has(pose.key)) fail('E_HYA_RUNTIME_LAYOUT', '$.layout.nodes', 'missing or colliding node identity');
      const instance = instances.get(pose.instanceId)!;
      const parentKey = node.parent ? this.evaluator.nodeKey(pose.instanceId, node.parent) : instance.hostNode;
      const parent = parentKey ? byKey.get(parentKey) : undefined;
      const box = rect(pose.rect), text = this.nextText.get(pose.key)?.arrange?.result;
      const matrix = transforms.get(pose.instanceId)!;
      layoutRectBounds(box,matrix);
      const textBlock = node.text ? this.document.textBlocks.find(block => block.id === node.text) : undefined;
      let clip = pose.clip ? rect(pose.clip) : undefined;
      if (textBlock && textBlock.overflow !== 'visible') clip = intersect(clip, box);
      clip = intersect(clip, parent?.clip);
      const clipShapes = [...(parent?.clipShapes ?? [])];
      if (pose.clip) clipShapes.push(Object.freeze({rect: rect(pose.clip), radii: Object.freeze([...pose.cornerRadius]) as Rect}));
      if (textBlock && textBlock.overflow !== 'visible' && !pose.clip) clipShapes.push(Object.freeze({rect: box, radii: Object.freeze([0, 0, 0, 0]) as Rect}));
      const definition = node.nSlice, sourceSize = pose.nSliceSourceSize ?? definition?.sourceSize;
      const source = pose.sourceCleared ? undefined : definition ? {kind: definition.source.kind, id: definition.source.kind === 'asset' ? pose.asset ?? definition.source.asset : definition.source.node} as const
        : pose.asset ? {kind: 'asset' as const, id: pose.asset} : undefined;
      const output: ProductionLayoutNode = Object.freeze({part: this.part, instance: pose.instanceId, artboard: pose.artboardId, node: pose.nodeId, kind: pose.kind,
        ...(matrix !== identityLayoutTransform ? {transform:matrix} : {}),
        rect: box, ...(clip ? {clip} : {}), opacity: pose.opacity * (parent?.opacity ?? 1),
        ...(clipShapes.length ? {clipShapes: Object.freeze(clipShapes)} : {}),
        ...(text ? {text} : {}), ...(source ? {source: Object.freeze(source)} : {}),
        ...(pose.background ? {background: Object.freeze([...pose.background]) as NonNullable<LayoutNodePose['background']>} : {}),
        ...(pose.borderColor ? {borderColor: Object.freeze([...pose.borderColor]) as NonNullable<LayoutNodePose['borderColor']>} : {}),
        borderWidth: Object.freeze([...pose.borderWidth]) as LayoutNodePose['borderWidth'], cornerRadius: Object.freeze([...pose.cornerRadius]) as LayoutNodePose['cornerRadius'],
        ...(pose.nSlice && definition ? {nSlice: Object.freeze(pose.nSlice.map(patch => Object.freeze({rect: rect(patch),
          uv: Object.freeze([(patch.source[0] + (patch.flipX ? patch.source[2] : 0)) / sourceSize![0], (patch.source[1] + (patch.flipY ? patch.source[3] : 0)) / sourceSize![1], patch.source[2] * (patch.flipX ? -1 : 1) / sourceSize![0], patch.source[3] * (patch.flipY ? -1 : 1) / sourceSize![1]]) as Rect,
          tile: patch.tileMode})))} : {})});
      byKey.set(pose.key, output); result.push(output);
    }
    const outputInstances: ProductionLayoutInstance[] = layout.instances.map(instance => Object.freeze({part: this.part, id: instance.id, artboard: instance.artboardId,
      ...(transforms.get(instance.id) !== identityLayoutTransform ? {transform:transforms.get(instance.id)!} : {}),
      ...(instance.parentId ? {parent: instance.parentId} : {}), ...(instance.hostNode ? {host: instance.hostNode} : {}),
      rect: rect(instance.rect), times: Object.freeze([...instance.times]), mixWeight: instance.mixWeight,
      inputs: instance.inputs as ProductionLayoutInstance['inputs'], events: instance.events as ProductionLayoutInstance['events']}));
    return Object.freeze({revision, viewport: Object.freeze([...layout.viewport]) as readonly [number, number], dpr: layout.dpr, nodes: Object.freeze(result), instances: Object.freeze(outputInstances)});
  }

  private snapshot(value: ProductionLayoutRequest): ProductionLayoutRequest {
    const request = snapshotPlainTextData(value, '$.layout', (path, message, limit) => fail(limit ? 'E_HYA_RUNTIME_LIMIT' : 'E_HYA_RUNTIME_LAYOUT', path, message)) as unknown as ProductionLayoutRequest;
    if (!request || Array.isArray(request) || typeof request !== 'object') fail('E_HYA_RUNTIME_LAYOUT', '$.layout', 'expected a layout request');
    const keys = new Set(['viewport', 'dpr', 'time', 'strings', 'selections', 'cursors', 'styles', 'lists', 'scroll', 'componentInputs', 'componentReplacements', 'componentEvents', 'componentStateTimes', 'priorRects', 'reflowProgress']);
    if (Object.keys(request).some(key => !keys.has(key))) fail('E_HYA_RUNTIME_LAYOUT', '$.layout', 'unknown layout request member');
    if (!Array.isArray(request.viewport) || request.viewport.length !== 2 || request.viewport.some(value => typeof value !== 'number' || value < 0)
      || typeof request.dpr !== 'number' || request.dpr <= 0 || typeof request.time !== 'number') fail('E_HYA_RUNTIME_LAYOUT', '$.layout', 'expected a finite viewport, positive DPR and time');
    for (const key of ['strings', 'selections', 'cursors', 'styles', 'lists', 'scroll', 'componentInputs', 'componentReplacements', 'componentEvents', 'componentStateTimes', 'priorRects'] as const) {
      const entry = request[key];
      if (entry !== undefined && (!entry || Array.isArray(entry) || typeof entry !== 'object')) fail('E_HYA_RUNTIME_LAYOUT', `$.layout.${key}`, 'expected a metadata map');
    }
    for (const [key, values] of Object.entries(request.lists ?? {})) if (!Array.isArray(values)) fail('E_HYA_RUNTIME_LAYOUT', `$.layout.lists.${key}`, 'expected a list');
    for (const [key, target] of Object.entries(request.componentReplacements ?? {})) if (typeof target !== 'string' || !this.nodes.has(target)) fail('E_HYA_RUNTIME_LAYOUT', `$.layout.componentReplacements.${key}`, 'unknown replacement artboard');
    for (const [key, state] of Object.entries(request.componentStateTimes ?? {})) if (typeof state !== 'number') fail('E_HYA_RUNTIME_LAYOUT', `$.layout.componentStateTimes.${key}`, 'expected finite state time');
    for (const [key, value] of Object.entries(request.strings ?? {})) if (typeof value !== 'string') fail('E_HYA_RUNTIME_LAYOUT', `$.layout.strings.${key}`, 'expected a string');
    for (const [key, value] of Object.entries(request.scroll ?? {})) {
      if (!isMap(value) || Object.keys(value).some(key => !['offset', 'velocity', 'active', 'settled'].includes(key))) fail('E_HYA_RUNTIME_LAYOUT', `$.layout.scroll.${key}`, 'invalid scroll input');
      for (const axis of ['offset', 'velocity'] as const) if (value[axis] !== undefined && !isVector(value[axis], 2)) fail('E_HYA_RUNTIME_LAYOUT', `$.layout.scroll.${key}.${axis}`, 'expected two finite coordinates');
      for (const name of ['active', 'settled'] as const) if (value[name] !== undefined && typeof value[name] !== 'boolean') fail('E_HYA_RUNTIME_LAYOUT', `$.layout.scroll.${key}.${name}`, 'expected boolean');
    }
    for (const [key, value] of Object.entries(request.componentInputs ?? {})) if (!isMap(value)) fail('E_HYA_RUNTIME_LAYOUT', `$.layout.componentInputs.${key}`, 'expected component input map');
    for (const [key, value] of Object.entries(request.componentEvents ?? {})) {
      if (!Array.isArray(value) || value.some(event => !isMap(event) || typeof event.name !== 'string' || Object.keys(event).some(key => !['name', 'payload'].includes(key)))) fail('E_HYA_RUNTIME_LAYOUT', `$.layout.componentEvents.${key}`, 'expected named component events');
    }
    for (const [key, value] of Object.entries(request.selections ?? {})) if (!isVector(value, 2) || value.some(offset => !Number.isSafeInteger(offset) || offset < 0)) fail('E_HYA_RUNTIME_LAYOUT', `$.layout.selections.${key}`, 'expected nonnegative UTF-16 offsets');
    for (const [key, value] of Object.entries(request.cursors ?? {})) if (!Number.isSafeInteger(value) || value < 0) fail('E_HYA_RUNTIME_LAYOUT', `$.layout.cursors.${key}`, 'expected a nonnegative UTF-16 offset');
    for (const [key, value] of Object.entries(request.priorRects ?? {})) if (!isMap(value) || !isVector([value.x, value.y, value.width, value.height], 4) || value.width < 0 || value.height < 0) fail('E_HYA_RUNTIME_LAYOUT', `$.layout.priorRects.${key}`, 'expected a finite previous rectangle');
    if (request.reflowProgress !== undefined && typeof request.reflowProgress !== 'number') fail('E_HYA_RUNTIME_LAYOUT', '$.layout.reflowProgress', 'expected finite progress');
    return request;
  }
  private assertLive(): void {
    if (this.disposed || this.signal?.aborted) fail(this.signal?.aborted ? 'E_HYA_RUNTIME_ABORTED' : 'E_HYA_RUNTIME_DISPOSED', '$.layout', 'layout owner is disposed');
  }
}

function sameWidths(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  return a.size === b.size && [...a].every(([key, width]) => b.get(key) === width);
}
function isMap(value: unknown): value is Record<string, unknown> {return value !== null && typeof value === 'object' && !Array.isArray(value);}
function isVector(value: unknown, size: number): value is number[] {return Array.isArray(value) && value.length === size && value.every(item => typeof item === 'number' && Number.isFinite(item));}
function rect(value: LayoutRect): Rect {
  const result: Rect = [value.x, value.y, value.width, value.height];
  if (result.some(value => !Number.isFinite(value)) || result[2] < 0 || result[3] < 0) fail('E_HYA_RUNTIME_LAYOUT', '$.layout.rect', 'layout produced invalid finite geometry');
  return Object.freeze(result);
}
function intersect(a: Rect | undefined, b: Rect | undefined): Rect | undefined {
  if (!a) return b; if (!b) return a;
  const x = Math.max(a[0], b[0]), y = Math.max(a[1], b[1]);
  return Object.freeze([x, y, Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x), Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y)]);
}
