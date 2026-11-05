import {GuiDirtyFlags, GuiElement, GuiLabel, GuiRoot, GuiScrollView, resolveGuiLength} from '@haiyue/engine/gui';
import type {GuiRect} from '@haiyue/engine/gui';
import {createLayoutSession, LayoutError} from '../layout.js';
import type {LayoutConstraints, LayoutLength, LayoutMeasure, LayoutNode, LayoutResult, LayoutSession, LayoutStyle} from '../layout.js';
import {frameStyle, presetStyle} from './presets.js';
import type {GuiLayoutBinding, GuiLayoutOptions, GuiLayoutStyle} from './types.js';
import {registerGuiLayoutCounters} from './diagnostics.js';
import {anchoredStyle, captureGuiLayoutStyle, coreStyle} from './style.js';
import {absoluteRect} from '../layout/box.js';
import {limitsFrom} from '../layout/validate.js';
import {createContentMinimumMeasure} from './minimum.js';
import {GuiLayoutResources} from './resources.js';
import {rememberLayoutVisibility} from './visibility.js';

interface Island {session: LayoutSession; fingerprint: string; result?: LayoutResult; alternate?: {fingerprint: string; result: LayoutResult} | undefined; viewportSession?: LayoutSession; viewportFingerprint?: string; viewportResult?: LayoutResult; contentMeasure?: LayoutMeasure;}
function length(value: number | `${number}%` | undefined): LayoutLength | undefined {return typeof value === 'string' ? {percent: Number.parseFloat(value)} : value;}
function exact(value: number): LayoutConstraints['width'] {return {mode: 'exact', value};}
const defaultMeasures=new WeakSet<LayoutMeasure>();
const geometryStyle=Symbol.for('haiyue.gui.layout-style-mutation.v1');
function defaultGuiLayoutOptions(root:GuiRoot):GuiLayoutOptions {
  const measure:LayoutMeasure=(id,constraints)=>{
    const element=root.findById(id);
    if(!element)throw new LayoutError('invalid-input','GUI measurement refers to a removed node.',id);
    return root.measureElement(element,constraints.width,constraints.height);
  };
  defaultMeasures.add(measure);return {measure};
}

/** Optional GUI adapter. All geometric calculation is delegated to the same pure core as HYA. */
export function attachGuiLayout(root: GuiRoot, options: GuiLayoutOptions = defaultGuiLayoutOptions(root)): GuiLayoutBinding {
  const limits = limitsFrom(options.limits);
  let overrides = new WeakMap<GuiElement, GuiLayoutStyle>();
  const versions = new WeakMap<GuiElement, number>();
  const islands = new Map<GuiElement, Island>();
  const signatures = new WeakMap<GuiElement, string>();
  const counters = {solves: 0, solvedNodes: 0, measurements: 0, sessions: 0};
  const releaseIsland = (island: Island): void => {island.session.dispose(); island.viewportSession?.dispose();};
  const countSessions = (): void => {counters.sessions = [...islands.values()].reduce((sum, island) => sum + (island.viewportSession ? 2 : 1), 0);};
  let disposed = false, uninstall = (): void => {}, unsubscribe = (): void => {};
  const visibilityOwner = {active: true};
  let metricsVersion = 0;
  const resources = new GuiLayoutResources(root.root, element => {versions.set(element, (versions.get(element) ?? 0) + 1); element.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);});
  const styleFor = (element: GuiElement): GuiLayoutStyle | undefined => {
    const preset = presetStyle(element), override = overrides.get(element), frame = frameStyle(element);
    return preset || override || frame ? {...preset, ...override, ...frame} : undefined;
  };
  const owned = (element: GuiElement): void => {
    let current: GuiElement | null = element;
    while (current && current !== root.root) {
      const parent: GuiElement | null = current.parent;
      if (parent && parent.constructor !== GuiElement && !(parent instanceof GuiScrollView)) throw new LayoutError('invalid-input', 'Composite control owns its internal child layout.', element.id);
      current = parent;
    }
    if (!current || disposed) throw new LayoutError('disposed', 'GUI binding is disposed or element belongs to another root.', element.id);
  };
  const dispose = (): void => {
    if (disposed) return; disposed = true;
    visibilityOwner.active = false;
    unsubscribe(); uninstall();
    resources.suspend();
    for (const island of islands.values()) releaseIsland(island);
    islands.clear(); overrides = new WeakMap();
    counters.sessions = 0;
  };
  const measure: LayoutMeasure = (id, constraints) => {counters.measurements++; return options.measure(id, constraints);};
  const styleMutations = new WeakSet<GuiElement>();
  const delegate:Parameters<GuiRoot['installLayoutDelegate']>[0] & {[geometryStyle]:(element:GuiElement)=>boolean}={
    [geometryStyle]: element => styleMutations.delete(element),
    measure(element, width, height) {return options.measure(element.id, {width, height});},
    arrange(gui, viewport, commit) {
      if (disposed) throw new LayoutError('disposed', 'GUI binding has been disposed.');
      const seen = new Set<GuiElement>(), byId = new Map<string, GuiElement>(), liveIslands = new Set<GuiElement>();
      resources.begin();
      const index = (element: GuiElement, depth = 1): void => {
        if (depth > limits.maxDepth || seen.size >= limits.maxNodes) throw new LayoutError('limit', 'GUI layout tree budget exceeded.', element.id);
        if (seen.has(element) || byId.has(element.id)) throw new LayoutError('invalid-input', 'GUI tree contains a cycle or duplicate ID.', element.id);
        seen.add(element); byId.set(element.id, element);
        const signature = resources.contentKey(element);
        if (signatures.get(element) !== signature) {signatures.set(element, signature); versions.set(element, (versions.get(element) ?? 0) + 1);}
        for (const child of element.children) index(child, depth + 1);
      };
      index(gui);
      const contentMinimum = createContentMinimumMeasure(measure);
      const output = new Map<GuiElement, GuiRect>();
      const metadata = new Map<GuiElement, {display?: 'none'; contentHeight?: number}>();
      const collapse = (element: GuiElement, origin: GuiRect): void => {
        output.set(element, {x: origin.x, y: origin.y, width: 0, height: 0}); metadata.set(element, {display: 'none'});
        for (const child of element.children) collapse(child, origin);
      };
      const solve = (element: GuiElement, origin: GuiRect, containing?: GuiRect): void => {
        if (styleFor(element)?.display === 'none') {collapse(element, origin); return;}
        liveIslands.add(element);
        let island = islands.get(element);
        if (!island) {island = {session: createLayoutSession(options.limits), fingerprint: ''}; islands.set(element, island);}
        countSessions();
        const nested: GuiElement[] = [];
        const build = (item: GuiElement, isRoot = false): LayoutNode => {
          const configured = styleFor(item), manual = item.getLayoutOptions();
          let style: LayoutStyle = {...(manual.width === undefined ? {} : {width: length(manual.width)!}), ...(manual.height === undefined ? {} : {height: length(manual.height)!}), ...(item instanceof GuiLabel && item.autoWidth ? {width: 'auto'} : {}), ...coreStyle(configured)};
          if (style.display === 'none') return {id: item.id, contentVersion: versions.get(item) ?? 0, style, children: []};
          resources.watch(item);
          const managesChildren = item.constructor === GuiElement || item instanceof GuiScrollView;
          // Leaf measurement already includes its own content insets. Containers
          // delegate that space to the shared solver unless layout overrides it.
          if (managesChildren && style.padding === undefined) {
            const skin = item.getResolvedStyle(), slice = skin.nineSlice, ratio = slice?.pixelRatio ?? 1;
            const padding = skin.contentInsets ?? slice?.contentInsets ?? (slice ? {
              left: slice.cuts[0] / ratio, top: slice.cuts[1] / ratio,
              right: slice.cuts[2] / ratio, bottom: slice.cuts[3] / ratio,
            } : skin.padding);
            if (padding !== undefined) style = {...style, padding: typeof padding === 'number' ? {top: padding, right: padding, bottom: padding, left: padding} : padding};
          }
          const ownsFlow = presetStyle(item) !== undefined || overrides.has(item);
          const fixedBoundary = !isRoot && configured && !configured.contentMinimum && managesChildren && item.children.length > 0 && typeof style.width === 'number' && typeof style.height === 'number';
          // A configured scroll flow needs the viewport allocated by its parent before
          // the original scroll solver measures unbounded content. Manual views stay manual.
          const scrollBoundary = !isRoot && item instanceof GuiScrollView && ownsFlow;
          const boundary = fixedBoundary || scrollBoundary;
          if (boundary) nested.push(item);
          // Composite controls keep their private children; plain unmanaged nodes are manual islands.
          const children = !boundary && ownsFlow && managesChildren ? item.children.map(child => build(child)) : [];
          const node = {id: item.id, contentVersion: versions.get(item) ?? 0, style, children};
          if (configured?.contentMinimum) {
            const min = contentMinimum(node);
            style = {...style, minWidth: style.minWidth ?? min.width, minHeight: style.minHeight ?? min.height};
          }
          return {...node, style};
        };
        let tree = build(element, true), constraints: LayoutConstraints = containing
          ? {width: {mode: 'at-most', value: containing.width}, height: {mode: 'at-most', value: containing.height}}
          : {width: exact(origin.width), height: exact(origin.height)};
        const configured = styleFor(element);
        if (containing && configured?.anchors) {
          const frame = absoluteRect({...tree, style: anchoredStyle(configured, containing.width, containing.height)}, containing, {width: 0, height: 0});
          tree = {...tree, style: {...tree.style, width: frame.width, height: frame.height}};
          constraints = {width: exact(frame.width), height: exact(frame.height)};
          origin = frame;
        }
        let scrollViewport: GuiRect | undefined;
        if (element instanceof GuiScrollView) {
          island.viewportSession ??= createLayoutSession(options.limits);
          countSessions();
          const viewportTree = {...tree, children: []}, viewportKey = JSON.stringify([viewportTree, constraints, metricsVersion]);
          if (island.viewportFingerprint !== viewportKey || !island.viewportResult) {
            island.viewportResult = island.viewportSession.update(viewportTree, constraints, measure, {metricsVersion});
            island.viewportFingerprint = viewportKey; counters.solves++; counters.solvedNodes += island.viewportResult.solvedNodes;
          }
          const view = island.viewportResult.rects.get(element.id)!;
          scrollViewport = {...view, x: view.x + origin.x, y: view.y + origin.y};
          const {height: _height, minHeight: _minHeight, maxHeight: _maxHeight, aspectRatio: _ratio, ...contentStyle} = tree.style;
          tree = {...tree, style: {...contentStyle, height: 'auto'}};
          constraints = {width: exact(view.width), height: {mode: 'unbounded'}};
          island.contentMeasure ??= (id, c) => id === element.id ? {width: 0, height: 0, minWidth: 0, minHeight: 0} : measure(id, c);
        }
        const fingerprint = JSON.stringify([tree, constraints, metricsVersion]);
        let result = island.result;
        if (fingerprint !== island.fingerprint || !result) {
          const alternate = island.alternate;
          const hit = alternate?.fingerprint === fingerprint;
          const next = hit ? alternate.result : island.session.update(tree, constraints, scrollViewport ? island.contentMeasure! : measure, {metricsVersion});
          if (!hit) {counters.solves++; counters.solvedNodes += next.solvedNodes;}
          // A warm solve may hit the session's intrinsic cache. Reuse only across
          // two solves with no new measurements or removal of a measured node.
          // User measurement and scroll content retain the original solver path.
          island.alternate = result && (hit ||
            !scrollViewport && defaultMeasures.has(options.measure) &&
            next.measuredNodes === 0 && result.measuredNodes === 0 &&
            next.rects.size === result.rects.size &&
            [...result.rects.keys()].every(id => next.rects.has(id)))
              ? {fingerprint: island.fingerprint, result} : undefined;
          result = next;
          island.result = result; island.fingerprint = fingerprint;
        }
        for (const [id, rect] of result.rects) {const item = byId.get(id); if (item) output.set(item, {...rect, x: rect.x + origin.x, y: rect.y + origin.y});}
        if (scrollViewport) {output.set(element, scrollViewport); metadata.set(element, {contentHeight: result.rects.get(element.id)!.height});}
        const collapsed = (node: LayoutNode): void => {
          if (node.style.display === 'none') collapse(byId.get(node.id)!, origin);
          else for (const child of node.children ?? []) collapsed(child);
        };
        collapsed(tree);
        for (const child of nested) if (result.rects.has(child.id)) solve(child, output.get(child)!);
      };
      const visitManual = (element: GuiElement, parent: GuiRect): void => {
        const manual = element.getLayoutOptions(), style = styleFor(element);
        const rect = {x: parent.x + resolveGuiLength(manual.x, parent.width, 0), y: parent.y + resolveGuiLength(manual.y, parent.height, 0), width: resolveGuiLength(manual.width, parent.width, element.rect.width), height: resolveGuiLength(manual.height, parent.height, element.rect.height)};
        if (style) {
          solve(element, rect, parent);
        } else if (element.constructor === GuiElement || element instanceof GuiScrollView) {
          const content = element instanceof GuiScrollView ? {...rect, height: element.contentHeight} : rect;
          for (const child of element.children) visitManual(child, content);
        }
      };
      visitManual(gui, viewport);
      for (const [element, rect] of output) commit(element, rect, metadata.get(element));
      resources.finish();
      for (const [element, island] of islands) if (!liveIslands.has(element)) {releaseIsland(island); islands.delete(element);}
      countSessions();
    },
    suspend() {resources.suspend(); for (const island of islands.values()) releaseIsland(island); islands.clear(); counters.sessions = 0;},
    dispose,
  };
  // Private cooperation with the original Engine owner; old/custom delegates
  // keep conservative text invalidation and the stable public signature is unchanged.
  Object.defineProperty(delegate,Symbol.for('haiyue.gui.text-layout-policy.v1'),{value:(element:GuiElement)=>{
    if(!defaultMeasures.has(options.measure)||disposed)return true;
    // Keep custom root measurements conservative without retaining the concrete
    // GuiRoot runtime (and its font/layout owners) in a layout-only consumer.
    const inherited=Object.getPrototypeOf(Object.getPrototypeOf(root)) as object|null;
    if(Object.hasOwn(root,'measureElement')||inherited&&'measureElement' in inherited)return true;
    const configured=styleFor(element),manual=element.getLayoutOptions(),style=coreStyle(configured);
    if(configured?.contentMinimum||element instanceof GuiLabel&&element.autoWidth)return true;
    const width=style.width??length(manual.width),height=style.height??length(manual.height);
    if(typeof width!=='number'||typeof height!=='number')return true;
    for(let parent=element.parent;parent;parent=parent.parent){
      if(styleFor(parent)?.contentMinimum)return true;
      const prototype=Object.getPrototypeOf(parent);
      if(prototype!==GuiElement.prototype&&prototype!==GuiScrollView.prototype)return true;
      if(parent.layout!==prototype.layout||parent.getLayoutOptions!==GuiElement.prototype.getLayoutOptions||parent.getResolvedStyle!==GuiElement.prototype.getResolvedStyle||parent.getContentRect!==GuiElement.prototype.getContentRect)return true;
    }
    return false;
  }});
  uninstall=root.installLayoutDelegate(delegate);
  unsubscribe = root.onInvalidation(change => {
    if (!change.reasons.includes('layout') && !change.reasons.includes('resource')) return;
    resources.prune();
    for (const [element, island] of islands) {
      let ancestor: GuiElement | null = element;
      while (ancestor && ancestor !== root.root) ancestor = ancestor.parent;
      if (!ancestor) {releaseIsland(island); islands.delete(element);}
    }
    countSessions();
    if (root.root.getDirtyFlags() & GuiDirtyFlags.Text) metricsVersion++;
  });
  const binding: GuiLayoutBinding = {
    setStyle(element, style) {
      owned(element);
      overrides.set(element, captureGuiLayoutStyle({...overrides.get(element), ...style}));
      rememberLayoutVisibility(element, overrides.get(element)!, visibilityOwner);
      // Keep normal synchronous invalidation. Only the original pixel source
      // watcher can defer its redundant rescan until the next prepare.
      styleMutations.add(element);
      try {element.markDirty(GuiDirtyFlags.Layout);}
      finally {styleMutations.delete(element);}
    },
    invalidate(element) {owned(element); versions.set(element, (versions.get(element) ?? 0) + 1); element.markDirty(GuiDirtyFlags.Layout);},
    dispose,
  };
  registerGuiLayoutCounters(binding, counters);
  return binding;
}
