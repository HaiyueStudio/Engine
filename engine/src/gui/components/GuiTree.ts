import { containsPoint, GuiDirtyFlags, GuiElementOptions, GuiPointerEvent, GuiRect, GuiValueChangeHandler } from '../GuiTypes';
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
    super({ width: 240, height: 180, ...options });
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

  private rebuildVisibleRows(): void {
    const rows: GuiTreeVisibleNode<T>[] = [];
    const bottom = this.rect.y + this.rect.height;
    const visit = (nodes: GuiTreeNode<T>[], depth: number): boolean => {
      for (const node of nodes) {
        const index = rows.length;
        const y = this.rect.y + index * this.rowHeight;
        if (y >= bottom) return false;
        rows.push({
          node,
          depth,
          index,
          rowRect: {
            x: this.rect.x,
            y,
            width: this.rect.width,
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
