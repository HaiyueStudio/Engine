import {GuiDirtyFlags, GuiElement, GuiLabel, GuiRoot, GuiScrollView, resolveGuiLength} from '@haiyue/engine/gui';
import type {GuiRect} from '@haiyue/engine/gui';
import {createLayoutSession, LayoutError} from '../layout.js';
import type {LayoutConstraints, LayoutLength, LayoutMeasure, LayoutNode, LayoutResult, LayoutSession, LayoutStyle} from '../layout.js';
import {presetStyle} from './presets.js';
import type {GuiLayoutBinding, GuiLayoutOptions, GuiLayoutStyle} from './types.js';
import {registerGuiLayoutCounters} from './diagnostics.js';
import {anchoredStyle, captureGuiLayoutStyle, coreStyle} from './style.js';
import {absoluteRect} from '../layout/box.js';
import {limitsFrom} from '../layout/validate.js';
import {createContentMinimumMeasure} from './minimum.js';
import {GuiLayoutResources} from './resources.js';

interface Island {session: LayoutSession; fingerprint: string; result?: LayoutResult; viewportSession?: LayoutSession; viewportFingerprint?: string; viewportResult?: LayoutResult; contentMeasure?: LayoutMeasure;}
function length(value: number | `${number}%` | undefined): LayoutLength | undefined {return typeof value === 'string' ? {percent: Number.parseFloat(value)} : value;}
function exact(value: number): LayoutConstraints['width'] {return {mode: 'exact', value};}

/** Optional GUI adapter. All geometric calculation is delegated to the same pure core as HYA. */
export function attachGuiLayout(root: GuiRoot, options: GuiLayoutOptions = {measure: (id, constraints) => {
  const element = root.findById(id);
  if (!element) throw new LayoutError('invalid-input', 'GUI measurement refers to a removed node.', id);
  const size = root.measureElement(element, constraints.width, constraints.height);
  return size;
}}): GuiLayoutBinding {
  const limits = limitsFrom(options.limits);
  const overrides = new Map<GuiElement, GuiLayoutStyle>(), versions = new WeakMap<GuiElement, number>();
  const islands = new Map<GuiElement, Island>();
  const signatures = new WeakMap<GuiElement, string>();
  const counters = {solves: 0, solvedNodes: 0, measurements: 0, sessions: 0};
  const releaseIsland = (island: Island): void => {island.session.dispose(); island.viewportSession?.dispose();};
  const countSessions = (): void => {counters.sessions = [...islands.values()].reduce((sum, island) => sum + (island.viewportSession ? 2 : 1), 0);};
  let disposed = false, uninstall = (): void => {}, unsubscribe = (): void => {};
  let metricsVersion = 0;
  const resources = new GuiLayoutResources(root.root, element => {versions.set(element, (versions.get(element) ?? 0) + 1); element.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);});
  const styleFor = (element: GuiElement): GuiLayoutStyle | undefined => overrides.get(element) ?? presetStyle(element);
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
    unsubscribe(); uninstall();
    resources.suspend();
    for (const island of islands.values()) releaseIsland(island);
    islands.clear(); overrides.clear();
    counters.sessions = 0;
  };
  const measure: LayoutMeasure = (id, constraints) => {counters.measurements++; return options.measure(id, constraints);};
  uninstall = root.installLayoutDelegate({
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
          const fixedBoundary = !isRoot && configured && !configured.contentMinimum && managesChildren && item.children.length > 0 && typeof style.width === 'number' && typeof style.height === 'number';
          if (fixedBoundary) nested.push(item);
          // Composite controls keep their private children; plain unmanaged nodes are manual islands.
          const children = !fixedBoundary && configured && managesChildren ? item.children.map(child => build(child)) : [];
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
          result = island.session.update(tree, constraints, scrollViewport ? island.contentMeasure! : measure, {metricsVersion});
          counters.solves++; counters.solvedNodes += result.solvedNodes;
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
      for (const element of overrides.keys()) if (!seen.has(element)) overrides.delete(element);
    },
    suspend() {resources.suspend(); for (const island of islands.values()) releaseIsland(island); islands.clear(); counters.sessions = 0;},
    dispose,
  });
  unsubscribe = root.onInvalidation(change => {
    if (!change.reasons.includes('layout') && !change.reasons.includes('resource')) return;
    resources.prune();
    for (const [element, island] of islands) {
      let ancestor: GuiElement | null = element;
      while (ancestor && ancestor !== root.root) ancestor = ancestor.parent;
      if (!ancestor) {releaseIsland(island); islands.delete(element); overrides.delete(element);}
    }
    countSessions();
    if (root.root.getDirtyFlags() & GuiDirtyFlags.Text) metricsVersion++;
  });
  const binding: GuiLayoutBinding = {
    setStyle(element, style) {
      owned(element);
      overrides.set(element, captureGuiLayoutStyle({...presetStyle(element), ...overrides.get(element), ...style}));
      // Mark through the public invalidation path; no private Engine state is accessed.
      element.markDirty(GuiDirtyFlags.Layout);
    },
    invalidate(element) {owned(element); versions.set(element, (versions.get(element) ?? 0) + 1); element.markDirty(GuiDirtyFlags.Layout);},
    dispose,
  };
  registerGuiLayoutCounters(binding, counters);
  return binding;
}
