import {GuiElement} from '../components/GuiElement';
import {GuiModal} from '../components/GuiModal';
import {isGuiLayoutHidden} from '../GuiLayoutState';
import type {GuiRect} from '../GuiTypes';

type Direction = 'left' | 'right' | 'up' | 'down';

/** One focus domain. Geometry is supplied by the input owner in host logical coordinates. */
export class GuiFocusManager {
  private current: GuiElement | null = null;
  private roots: readonly GuiElement[] | null = null;
  private modals: {modal: GuiModal; previous: GuiElement | null}[] = [];
  private revision = 0;
  private readonly changes=new Set<()=>void>();
  private readonly beforeBlur=new Set<()=>void>();
  private rectFor: (element: GuiElement) => Readonly<GuiRect> = element => element.rect;

  get focused(): GuiElement | null { return this.current; }
  get generation(): number { return this.revision; }
  get modal(): GuiModal | null { return this.modals.at(-1)?.modal ?? null; }
  subscribe(changed:()=>void):()=>void {this.changes.add(changed);return ()=>{this.changes.delete(changed);};}
  subscribeBeforeBlur(changed:()=>void):()=>void {this.beforeBlur.add(changed);return ()=>{this.beforeBlur.delete(changed);};}

  setRoots(roots: Iterable<GuiElement>, rectFor?: (element: GuiElement) => Readonly<GuiRect>): void {
    this.roots = [...roots];
    if (rectFor) this.rectFor = rectFor;
    this.reconcile();
  }

  /** Re-read public state so direct visible/disabled changes also invalidate eligibility. */
  reconcile(): void {
    if (!this.roots) return;
    const visible: GuiModal[] = [];
    const visit = (node: GuiElement): void => {
      if (!this.active(node)) return;
      if (node instanceof GuiModal) visible.push(node);
      for (const child of node.children) visit(child);
    };
    for (const root of this.roots) visit(root);
    let common = 0;
    while (common < visible.length && visible[common] === this.modals[common]?.modal) common++;
    let restored: GuiElement | null | undefined;
    while (this.modals.length > common) restored = this.modals.pop()!.previous;
    for (let i = common; i < visible.length; i++) {
      this.modals.push({modal: visible[i]!, previous: restored === undefined ? this.current : restored});
      restored = undefined;
    }
    if (restored !== undefined) this.focus(this.eligible(restored) ? restored : this.candidates()[0] ?? null);
    else if ((this.current && !this.eligible(this.current)) || (this.modal && !this.eligible(this.current)))
      this.focus(this.candidates()[0] ?? null);
  }

  focus(element: GuiElement | null): void {
    if (element && !this.eligible(element)) return;
    if (this.current === element) return;
    const ticket = ++this.revision, previous = this.current;
    for(const listener of [...this.beforeBlur]){listener();if(ticket!==this.revision)return;}
    this.current = null;
    previous?.handleBlur();
    if (ticket !== this.revision) return;
    this.current = element;
    element?.handleFocus();
    if(ticket===this.revision)for(const listener of [...this.changes])listener();
  }

  blur(): void { this.focus(null); }

  next(reverse = false): GuiElement | null {
    this.reconcile();
    const nodes = this.candidates().filter(n => (n.focusOptions.tabIndex ?? 0) >= 0);
    nodes.sort((a,b) => (a.focusOptions.tabIndex ?? 0) - (b.focusOptions.tabIndex ?? 0));
    if (!nodes.length) return null;
    const index = nodes.indexOf(this.current!);
    const target = nodes[index < 0 ? reverse ? nodes.length - 1 : 0 : (index + (reverse ? -1 : 1) + nodes.length) % nodes.length]!;
    this.focus(target);
    return target;
  }

  move(direction: Direction): GuiElement | null {
    this.reconcile();
    if (!this.current) return this.next();
    const nodes = this.candidates(), explicit = this.current.focusOptions.neighbours?.[direction];
    const neighbour = explicit ? nodes.find(n => n.id === explicit) : null;
    if (neighbour && neighbour !== this.current) { this.focus(neighbour); return neighbour; }
    const origin = this.rectFor(this.current), horizontal = direction === 'left' || direction === 'right';
    const sign = direction === 'left' || direction === 'up' ? -1 : 1;
    const scored = nodes.filter(n => n !== this.current).map(node => {
      const r = this.rectFor(node), dx = r.x + r.width / 2 - origin.x - origin.width / 2;
      const dy = r.y + r.height / 2 - origin.y - origin.height / 2;
      const forward = (horizontal ? dx : dy) * sign, cross = horizontal ? dy : dx;
      return {node, forward, angle: Math.atan2(Math.abs(cross), forward), distance: dx * dx + dy * dy};
    }).filter(n => n.forward > 0);
    scored.sort((a,b) => a.angle - b.angle || a.distance - b.distance || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
    const target = scored[0]?.node ?? null;
    if (target) this.focus(target);
    return target;
  }

  dispose(): void { this.blur(); this.modals = []; this.roots = []; this.changes.clear();this.beforeBlur.clear(); }

  private active(node: GuiElement): boolean { return node.visible && !node.disabled && !isGuiLayoutHidden(node); }
  private eligible(node: GuiElement | null): node is GuiElement {
    if (!node || node.focusOptions.mode === 'none') return false;
    let root = node;
    for (let p: GuiElement | null = node; p; p = p.parent) {
      if (!this.active(p)) return false;
      root = p;
    }
    if (this.roots && !this.roots.includes(root)) return false;
    const modal = this.modal;
    if (modal) { for (let p: GuiElement | null = node; p; p=p.parent) if (p === modal) return true; return false; }
    return true;
  }
  private candidates(): GuiElement[] {
    const result: GuiElement[] = [];
    const visit = (node: GuiElement): void => {
      if (!this.active(node)) return;
      if (node.focusOptions.mode === 'all') result.push(node);
      for (const child of node.children) visit(child);
    };
    if (this.modal) visit(this.modal);
    else for (const root of this.roots ?? []) visit(root);
    return result;
  }
}
