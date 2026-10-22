import { containsPoint, GuiDirtyFlags, GuiElementOptions, GuiPointerEvent, GuiRect, GuiValueChangeHandler, type GuiActionEvent } from '../GuiTypes';
import { GuiElement } from './GuiElement';
import { requiredItemAt } from '../../math/arrayAccess';

export interface GuiTreeNode<T = string> {
  key: string;
  label: string;
  value?: T;
  disabled?: boolean;
  children?: GuiTreeNode<T>[];
}

export interface GuiTreeVisibleNode<T = string> {
  node: GuiTreeNode<T>;
  depth: number;
  index: number;
  rowRect: GuiRect;
}

export interface GuiTreeOptions<T = string> extends GuiElementOptions {
  nodes?: GuiTreeNode<T>[];
  expandedKeys?: Iterable<string>;
  selectedKey?: string | null;
  rowHeight?: number;
  indent?: number;
  onExpand?: GuiValueChangeHandler<string[]>;
  onSelect?: GuiValueChangeHandler<GuiTreeNode<T>>;
}

export class GuiTree<T = string> extends GuiElement {
  static override readonly themeControlType: string = 'GuiTree';
  nodes: GuiTreeNode<T>[];
  expandedKeys: Set<string>;
  selectedKey: string | null;
  rowHeight: number;
  indent: number;
  onExpand: GuiValueChangeHandler<string[]> | null;
  onSelect: GuiValueChangeHandler<GuiTreeNode<T>> | null;

  private visibleRows: GuiTreeVisibleNode<T>[] = [];
  private rowsDirty = true;

  constructor(options: GuiTreeOptions<T> = {}) {
    super({ width: 240, height: 180, focus: {mode: 'all'}, ...options });
    this.nodes = options.nodes ?? [];
    this.expandedKeys = new Set(options.expandedKeys ?? []);
    this.selectedKey = options.selectedKey ?? null;
    this.rowHeight = options.rowHeight ?? 28;
    this.indent = options.indent ?? 18;
    this.onExpand = options.onExpand ?? null;
    this.onSelect = options.onSelect ?? null;
  }

  get visibleNodes(): GuiTreeVisibleNode<T>[] {
    if (this.rowsDirty) this.rebuildVisibleRows();
    return this.visibleRows;
  }

  setNodes(nodes: GuiTreeNode<T>[]): void {
    this.nodes = nodes;
    this.rowsDirty = true;
    this.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual | GuiDirtyFlags.Text);
  }

  setExpanded(key: string, expanded: boolean, emit = false): void {
    const had = this.expandedKeys.has(key);
    if (had === expanded) return;
    if (expanded) this.expandedKeys.add(key);
    else this.expandedKeys.delete(key);
    this.rowsDirty = true;
    this.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual | GuiDirtyFlags.Text | GuiDirtyFlags.Input);
    if (emit) this.onExpand?.(Array.from(this.expandedKeys));
  }

  toggleExpanded(key: string, emit = false): void {
    this.setExpanded(key, !this.expandedKeys.has(key), emit);
  }

  setSelectedKey(key: string | null, emit = false): void {
    if (this.selectedKey === key) return;
    this.selectedKey = key;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
    if (emit && key !== null) {
      const node = this.findNode(key);
      if (node) this.onSelect?.(node);
    }
  }

  findNode(key: string): GuiTreeNode<T> | null {
    const stack = [...this.nodes];
    for (let i = 0; i < stack.length; i++) {
      const node = requiredItemAt(stack, i, 'GUI tree traversal');
      if (node.key === key) return node;
      if (node.children) stack.push(...node.children);
    }
    return null;
  }

  getRowAt(x: number, y: number): GuiTreeVisibleNode<T> | null {
    if (!containsPoint(this.rect, x, y)) return null;
    const index = Math.floor((y - this.rect.y) / this.rowHeight);
    return this.visibleNodes[index] ?? null;
  }

  isOnExpander(row: GuiTreeVisibleNode<T>, x: number): boolean {
    if (!row.node.children?.length) return false;
    const expanderX = this.rect.x + row.depth * this.indent + 4;
    return x >= expanderX && x <= expanderX + 16;
  }

  override handleClick(event: GuiPointerEvent): void {
    super.handleClick(event);
    const row = this.getRowAt(event.x, event.y);
    if (!row || row.node.disabled) return;
    if (this.isOnExpander(row, event.x)) {
      this.toggleExpanded(row.node.key, true);
      return;
    }
    this.setSelectedKey(row.node.key, true);
  }

  override handleAction(event: GuiActionEvent): void {
    super.handleAction(event);
    if(event.consumed)return;
    const rows=this.visibleNodes,enabled=rows.filter(row=>!row.node.disabled);
    const selected=rows.find(row=>row.node.key===this.selectedKey);
    if(event.action==='up'||event.action==='down') {
      if(!enabled.length)return;
      const index=enabled.findIndex(row=>row.node.key===this.selectedKey);
      const next=enabled[index<0?0:Math.max(0,Math.min(enabled.length-1,index+(event.action==='down'?1:-1)))];
      if(next)this.setSelectedKey(next.node.key,true);
      event.consume();
    } else if(event.action==='right'&&selected&&!selected.node.disabled&&selected.node.children?.length) {
      if(!this.expandedKeys.has(selected.node.key))this.setExpanded(selected.node.key,true,true);
      else {const after=this.visibleNodes.slice(selected.index+1),end=after.findIndex(row=>row.depth<=selected.depth);const child=(end<0?after:after.slice(0,end)).find(row=>row.depth===selected.depth+1&&!row.node.disabled);if(child)this.setSelectedKey(child.node.key,true);}
      event.consume();
    } else if(event.action==='left'&&selected&&!selected.node.disabled) {
      if(this.expandedKeys.has(selected.node.key))this.setExpanded(selected.node.key,false,true);
      else {const parent=rows.slice(0,selected.index).reverse().find(row=>row.depth<selected.depth&&!row.node.disabled);if(!parent)return;this.setSelectedKey(parent.node.key,true);}
      event.consume();
    } else if(event.action==='confirm'&&enabled.length) {
      const row=selected&&!selected.node.disabled?selected:enabled[0];
      if(row){if(this.selectedKey===row.node.key)this.onSelect?.(row.node);else this.setSelectedKey(row.node.key,true);event.consume();}
    }
  }

  private rebuildVisibleRows(): void {
    const rows: GuiTreeVisibleNode<T>[] = [];
    const content = this.getContentRect(), bottom = content.y + content.height;
    const visit = (nodes: GuiTreeNode<T>[], depth: number): boolean => {
      for (const node of nodes) {
        const index = rows.length;
        const y = content.y + index * this.rowHeight;
        if (y >= bottom) return false;
        rows.push({
          node,
          depth,
          index,
          rowRect: {
            x: content.x,
            y,
            width: content.width,
            height: this.rowHeight,
          },
        });
        if (node.children?.length && this.expandedKeys.has(node.key)) {
          if (!visit(node.children, depth + 1)) return false;
        }
      }
      return true;
    };
    visit(this.nodes, 0);
    this.visibleRows = rows;
    this.rowsDirty = false;
  }

  override layout(parentRect: GuiRect): void {
    super.layout(parentRect);
    this.rowsDirty = true;
  }
}
