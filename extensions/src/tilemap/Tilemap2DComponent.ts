import { Component } from '@haiyue/engine';
import { UniqueCheckType } from '@haiyue/engine/ecs';

export type TilemapCellValue = number;
export type TilemapPaletteColor = [number, number, number, number];

export interface Tilemap2DComponentOptions {
  columns?: number;
  rows?: number;
  cellWidth?: number;
  cellHeight?: number;
  originX?: number;
  originY?: number;
  gap?: number;
  cells?: ArrayLike<TilemapCellValue>;
  palette?: TilemapPaletteColor[];
}

export class Tilemap2DComponent extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Tilemap2DComponent');
  static editor = {
    fields: {
      columns: { type: 'number', label: 'Columns', min: 1, step: 1 },
      rows: { type: 'number', label: 'Rows', min: 1, step: 1 },
      cellWidth: { type: 'number', label: 'Cell Width', min: 0.001, step: 1 },
      cellHeight: { type: 'number', label: 'Cell Height', min: 0.001, step: 1 },
      gap: { type: 'number', label: 'Gap', min: 0, step: 1 },
      originX: { type: 'number', label: 'Origin X', step: 1 },
      originY: { type: 'number', label: 'Origin Y', step: 1 },
      palette: { type: 'json', label: 'Palette JSON', rows: 7 },
      cells: { type: 'int-array', label: 'Cells JSON', rows: 8 },
    },
  };

  private _columns: number;
  private _rows: number;
  private _cellWidth: number;
  private _cellHeight: number;
  private _originX: number;
  private _originY: number;
  private _gap: number;
  private _cells: Int16Array;
  private _palette: TilemapPaletteColor[];
  private _version = 0;

  constructor(options: Tilemap2DComponentOptions = {}) {
    super('Tilemap2DComponent');
    this._columns = Math.max(1, Math.floor(options.columns ?? 10));
    this._rows = Math.max(1, Math.floor(options.rows ?? 20));
    this._cellWidth = options.cellWidth ?? 32;
    this._cellHeight = options.cellHeight ?? 32;
    this._originX = options.originX ?? 0;
    this._originY = options.originY ?? 0;
    this._gap = Math.max(0, options.gap ?? 1);
    this._cells = new Int16Array(this.columns * this.rows);
    if (options.cells) this._cells.set(Array.from(options.cells).slice(0, this._cells.length));
    this._palette = options.palette?.length
      ? options.palette.map(color => [...color] as TilemapPaletteColor)
      : [
          [0, 0, 0, 0],
          [0.18, 0.62, 1, 1],
          [0.96, 0.72, 0.18, 1],
          [0.35, 0.86, 0.48, 1],
          [0.92, 0.28, 0.36, 1],
        ];
  }

  get columns(): number {
    return this._columns;
  }

  set columns(value: number) {
    const next = Math.max(1, Math.floor(value));
    if (this._columns === next) return;
    this._columns = next;
    this.markDirty();
  }

  get rows(): number {
    return this._rows;
  }

  set rows(value: number) {
    const next = Math.max(1, Math.floor(value));
    if (this._rows === next) return;
    this._rows = next;
    this.markDirty();
  }

  get cellWidth(): number {
    return this._cellWidth;
  }

  set cellWidth(value: number) {
    if (this._cellWidth === value) return;
    this._cellWidth = value;
    this.markDirty();
  }

  get cellHeight(): number {
    return this._cellHeight;
  }

  set cellHeight(value: number) {
    if (this._cellHeight === value) return;
    this._cellHeight = value;
    this.markDirty();
  }

  get originX(): number {
    return this._originX;
  }

  set originX(value: number) {
    if (this._originX === value) return;
    this._originX = value;
    this.markDirty();
  }

  get originY(): number {
    return this._originY;
  }

  set originY(value: number) {
    if (this._originY === value) return;
    this._originY = value;
    this.markDirty();
  }

  get gap(): number {
    return this._gap;
  }

  set gap(value: number) {
    const next = Math.max(0, value);
    if (this._gap === next) return;
    this._gap = next;
    this.markDirty();
  }

  get cells(): Int16Array {
    return this._cells;
  }

  set cells(value: Int16Array) {
    this._cells = value;
    this.markDirty();
  }

  get palette(): TilemapPaletteColor[] {
    return this._palette;
  }

  set palette(value: TilemapPaletteColor[]) {
    this._palette = value;
    this.markDirty();
  }

  get version(): number {
    return this._version;
  }

  markDirty(): this {
    this._version++;
    return this;
  }

  index(column: number, row: number): number {
    return row * this.columns + column;
  }

  contains(column: number, row: number): boolean {
    return column >= 0 && row >= 0 && column < this.columns && row < this.rows;
  }

  getCell(column: number, row: number): TilemapCellValue {
    if (!this.contains(column, row)) return 0;
    return this.cells[this.index(column, row)] ?? 0;
  }

  setCell(column: number, row: number, value: TilemapCellValue): this {
    if (this.contains(column, row)) {
      const index = this.index(column, row);
      if (this._cells[index] !== value) {
        this._cells[index] = value;
        this.markDirty();
      }
    }
    return this;
  }

  clear(value = 0): this {
    this._cells.fill(value);
    this.markDirty();
    return this;
  }

  resize(columns: number, rows: number): this {
    const nextColumns = Math.max(1, Math.floor(columns));
    const nextRows = Math.max(1, Math.floor(rows));
    if (nextColumns === this.columns && nextRows === this.rows) return this;

    const next = new Int16Array(nextColumns * nextRows);
    const copyColumns = Math.min(this.columns, nextColumns);
    const copyRows = Math.min(this.rows, nextRows);
    for (let row = 0; row < copyRows; row++) {
      for (let column = 0; column < copyColumns; column++) {
        next[row * nextColumns + column] = this.getCell(column, row);
      }
    }
    this._columns = nextColumns;
    this._rows = nextRows;
    this._cells = next;
    this.markDirty();
    return this;
  }

  override clone(): Tilemap2DComponent {
    return new Tilemap2DComponent({
      columns: this.columns,
      rows: this.rows,
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      originX: this.originX,
      originY: this.originY,
      gap: this.gap,
      cells: this.cells,
      palette: this.palette,
    });
  }
}
