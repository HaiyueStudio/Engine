import {GuiElement, GuiImage} from '@haiyue/engine/gui';

function belongs(element: GuiElement, root: GuiElement): boolean {
  for (let parent: GuiElement | null = element; parent; parent = parent.parent) if (parent === root) return true;
  return false;
}
/** Borrowed source notifications belong to the attachment, never to the image/texture owner. */
export class GuiLayoutResources {
  private readonly watched = new Map<GuiImage, {source: unknown; release: () => void}>();
  private live = new Set<GuiImage>();
  private readonly identities = new WeakMap<object, number>();
  private identity = 0;
  constructor(private readonly root: GuiElement, private readonly invalidate: (element: GuiElement) => void) {}
  begin(): void {this.live.clear();}
  watch(element: GuiElement): void {
    if (!(element instanceof GuiImage)) return;
    this.live.add(element);
    const previous = this.watched.get(element), source = element.source;
    if (previous?.source === source) return;
    previous?.release(); this.watched.delete(element);
    if (!source || !('addEventListener' in source) || !('removeEventListener' in source)) return;
    const changed = (): void => {if (element.source === source && belongs(element, this.root)) this.invalidate(element);};
    source.addEventListener('load', changed); source.addEventListener('error', changed);
    this.watched.set(element, {source, release: () => {source.removeEventListener('load', changed); source.removeEventListener('error', changed);}});
  }
  finish(): void {for (const [element, entry] of this.watched) if (!this.live.has(element)) {entry.release(); this.watched.delete(element);}}
  prune(): void {for (const [element, entry] of this.watched) if (!belongs(element, this.root)) {entry.release(); this.watched.delete(element);}}
  suspend(): void {for (const entry of this.watched.values()) entry.release(); this.watched.clear(); this.live.clear();}
  contentKey(element: GuiElement): string {
    let image: readonly unknown[] = [];
    if (element instanceof GuiImage && element.source) {
      const source = element.source;
      let identity = this.identities.get(source);
      if (!identity) {identity = ++this.identity; this.identities.set(source, identity);}
      const texture = 'texture' in source ? source.texture : source;
      image = [identity, 'version' in source ? source.version : 0, 'naturalWidth' in texture ? texture.naturalWidth : 'width' in texture ? texture.width : 0, 'naturalHeight' in texture ? texture.naturalHeight : 'height' in texture ? texture.height : 0];
    }
    return JSON.stringify(['text' in element ? element.text : undefined, 'fontSize' in element ? element.fontSize : undefined, 'value' in element ? element.value : undefined, 'placeholder' in element ? element.placeholder : undefined, element.style.padding, image]);
  }
}
