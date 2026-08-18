import { Component } from '@haiyue/engine';
import { UniqueCheckType } from '@haiyue/engine/ecs';

export interface Grid2DComponentOptions {
  columns?: number;
  rows?: number;
  cellWidth?: number;
  cellHeight?: number;
  originX?: number;
  originY?: number;
}

export class Grid2DComponent extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Grid2DComponent');

  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  originX: number;
  originY: number;

  constructor(options: Grid2DComponentOptions = {}) {
    super('Grid2DComponent');
    this.columns = Math.max(1, Math.floor(options.columns ?? 10));
    this.rows = Math.max(1, Math.floor(options.rows ?? 20));
    this.cellWidth = options.cellWidth ?? 32;
    this.cellHeight = options.cellHeight ?? 32;
    this.originX = options.originX ?? 0;
    this.originY = options.originY ?? 0;
  }

  gridToWorld(column: number, row: number): [number, number] {
    return [
      this.originX + column * this.cellWidth,
      this.originY + row * this.cellHeight,
    ];
  }

  gridToWorldCenter(column: number, row: number): [number, number] {
    return [
      this.originX + (column + 0.5) * this.cellWidth,
      this.originY + (row + 0.5) * this.cellHeight,
    ];
  }

  worldToGrid(x: number, y: number): [number, number] {
    return [
      Math.floor((x - this.originX) / this.cellWidth),
      Math.floor((y - this.originY) / this.cellHeight),
    ];
  }

  contains(column: number, row: number): boolean {
    return column >= 0 && row >= 0 && column < this.columns && row < this.rows;
  }

  override clone(): Grid2DComponent {
    return new Grid2DComponent({
      columns: this.columns,
      rows: this.rows,
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      originX: this.originX,
      originY: this.originY,
    });
  }
}
