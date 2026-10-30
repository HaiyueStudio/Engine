import {isGuiControl} from './GuiControlIdentity';
import {type GuiImage, type GuiImageSource} from './components/GuiImage';
import {type GuiToast} from './components/GuiToast';
import type {GuiRoot} from './components/GuiRoot';
import type {GuiElement} from './components/GuiElement';
import {observeGuiRootDisposal} from './GuiLayoutState';
import {guiThemeTreeActive} from './GuiThemeResolve';

type Source = NonNullable<GuiImageSource>;
interface Watched {nodes: Set<GuiElement>; key: string; release: () => void;}
function sources(element: GuiElement, themed: boolean): Set<Source> {
  const result = new Set<Source>();
  if (isGuiControl<GuiImage>(element, 'GuiImage') && element.source) result.add(element.source);
  const skin = themed ? element.getResolvedStyle() : undefined;
  if (isGuiControl<GuiToast>(element, 'GuiToast') && (skin?.icon ?? element.icon)) result.add((skin?.icon ?? element.icon)!);
  if (themed) {
    if (skin?.icon) result.add(skin.icon);
    if (skin?.nineSlice?.source) result.add(skin.nineSlice.source);
  }
  return result;
}

/** Shared per-source readiness watches also cover borrowed theme icons and skins. */
export class GuiPixelResources {
  private readonly watched = new Map<Source, Watched>();
  private readonly rootObservers = new Map<GuiRoot, () => void>();
  private roots: readonly GuiRoot[] = [];
  private syncing = false;
  constructor(private readonly changed: (element: GuiElement, source: Source) => void) {}

  sync(roots: readonly GuiRoot[]): void {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const active = roots.filter(root => !root.destroyed);
      const rebuild = active.length !== this.roots.length || active.some((root, i) => root !== this.roots[i] || root.dirty);
      this.roots = active;
      for (const [root, release] of this.rootObservers) if (!active.includes(root)) {release(); this.rootObservers.delete(root);}
      for (const root of active) if (!this.rootObservers.has(root)) {
        const off = root.onInvalidation(() => this.sync(this.roots));
        const disposed = observeGuiRootDisposal(root.root, () => this.sync(this.roots.filter(r => r !== root)));
        this.rootObservers.set(root, () => {off(); disposed();});
      }
      if (rebuild) {
        const live = new Map<Source, Set<GuiElement>>();
        for (const root of active) {
          const themed = guiThemeTreeActive(root.root), visit = (element: GuiElement): void => {
            for (const source of sources(element, themed)) {
              let nodes = live.get(source); if (!nodes) {nodes = new Set(); live.set(source, nodes);}
              nodes.add(element);
            }
            for (const child of element.children) visit(child);
          };
          visit(root.root);
        }
        for (const [source, entry] of this.watched) if (!live.has(source)) {entry.release(); this.watched.delete(source);}
        for (const [source, nodes] of live) {
          const previous = this.watched.get(source);
          if (previous) {previous.nodes = nodes; continue;}
          const loaded = () => this.signal(source);
          if ('addEventListener' in source && 'removeEventListener' in source) {source.addEventListener('load', loaded); source.addEventListener('error', loaded);}
          this.watched.set(source, {nodes, key: this.key(source), release: () => {
            if ('removeEventListener' in source) {source.removeEventListener('load', loaded); source.removeEventListener('error', loaded);}
          }});
        }
      }
      for (const [source, entry] of this.watched) {
        const next = this.key(source);
        if (next !== entry.key) {entry.key = next; this.signal(source);}
      }
    } finally {this.syncing = false;}
  }

  release(): void {
    for (const entry of this.watched.values()) entry.release(); this.watched.clear();
    for (const release of this.rootObservers.values()) release(); this.rootObservers.clear(); this.roots = [];
  }

  private signal(source: Source): void {
    const entry = this.watched.get(source); if (!entry) return;
    entry.key = this.key(source);
    for (const node of [...entry.nodes]) {
      let top = node; while (top.parent) top = top.parent;
      const root = this.roots.find(root => !root.destroyed && root.root === top);
      if (root && sources(node, guiThemeTreeActive(root.root)).has(source)) this.changed(node, source);
    }
  }

  private key(source: Source): string {
    const dimensions = 'texture' in source ? source.texture : source;
    return JSON.stringify(['version' in source ? source.version : 0,
      'naturalWidth' in dimensions ? dimensions.naturalWidth : 'width' in dimensions ? dimensions.width : 0,
      'naturalHeight' in dimensions ? dimensions.naturalHeight : 'height' in dimensions ? dimensions.height : 0,
      'currentSrc' in source ? source.currentSrc : undefined, 'complete' in source ? source.complete : undefined]);
  }
}
