import {initializeTilemap,tilemapState,checkedAtlas,validateMapSize,validateAtlasCells,validateAtlasCell,invalidateTilemap,dirtyTile,cellTransforms,tilemapInvalid,type TilemapAtlasOptions,type TilemapCellTransform} from './TilemapState';
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
  atlas?: TilemapAtlasOptions | null;
  chunkSize?: number;
  maxResidentChunks?: number;
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
    const atlas=checkedAtlas(options.atlas??null),chunkSize=options.chunkSize??32,maxResident=options.maxResidentChunks??64,explicitChunks=options.chunkSize!==undefined||options.maxResidentChunks!==undefined;
    if(!Number.isSafeInteger(chunkSize)||chunkSize<1||chunkSize>64||!Number.isSafeInteger(maxResident)||maxResident<1||maxResident>256)throw tilemapInvalid('Invalid chunk size or resident chunk limit.');
    this._columns = Math.max(1, Math.floor(options.columns ?? 10));
    this._rows = Math.max(1, Math.floor(options.rows ?? 20));
    this._cellWidth = options.cellWidth ?? 32;
    this._cellHeight = options.cellHeight ?? 32;
    this._originX = options.originX ?? 0;
    this._originY = options.originY ?? 0;
    this._gap = Math.max(0, options.gap ?? 1);
    validateMapSize(this.columns,this.rows,options.cells??{length:this.columns*this.rows},!!atlas||explicitChunks);
    validateAtlasCells(options.cells??[],atlas);
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
    initializeTilemap(this,{atlas,chunkSize,maxResident,explicitChunks,fullRevision:0,clock:0,dirty:new Map(),transforms:new Map()});
    if(atlas||explicitChunks)this.validateGeometry();
  }

  get columns(): number {
    return this._columns;
  }

  set columns(value: number) {
    const next = Math.max(1, Math.floor(value));
    if (this._columns === next) return;
    this.validateDimensions(next,this.rows);
    this._columns = next;
    for(const index of tilemapState(this).transforms.keys())if(index>=this.columns*this.rows)tilemapState(this).transforms.delete(index);
    this.markDirty();
  }

  get rows(): number {
    return this._rows;
  }

  set rows(value: number) {
    const next = Math.max(1, Math.floor(value));
    if (this._rows === next) return;
    this.validateDimensions(this.columns,next);
    this._rows = next;
    for(const index of tilemapState(this).transforms.keys())if(index>=this.columns*this.rows)tilemapState(this).transforms.delete(index);
    this.markDirty();
  }

  get cellWidth(): number {
    return this._cellWidth;
  }

  set cellWidth(value: number) {
    if (this._cellWidth === value) return;
    if((tilemapState(this).atlas||tilemapState(this).explicitChunks)&&(!Number.isFinite(value)||value<=0))throw tilemapInvalid('Invalid cellWidth.');
    this._cellWidth = value;
    this.markDirty();
  }

  get cellHeight(): number {
    return this._cellHeight;
  }

  set cellHeight(value: number) {
    if (this._cellHeight === value) return;
    if((tilemapState(this).atlas||tilemapState(this).explicitChunks)&&(!Number.isFinite(value)||value<=0))throw tilemapInvalid('Invalid cellHeight.');
    this._cellHeight = value;
    this.markDirty();
  }

  get originX(): number {
    return this._originX;
  }

  set originX(value: number) {
    if (this._originX === value) return;
    if((tilemapState(this).atlas||tilemapState(this).explicitChunks)&&(!Number.isFinite(value)))throw tilemapInvalid('Invalid originX.');
    this._originX = value;
    this.markDirty();
  }

  get originY(): number {
    return this._originY;
  }

  set originY(value: number) {
    if (this._originY === value) return;
    if((tilemapState(this).atlas||tilemapState(this).explicitChunks)&&(!Number.isFinite(value)))throw tilemapInvalid('Invalid originY.');
    this._originY = value;
    this.markDirty();
  }

  get gap(): number {
    return this._gap;
  }

  set gap(value: number) {
    const next = Math.max(0, value);
    if (this._gap === next) return;
    if((tilemapState(this).atlas||tilemapState(this).explicitChunks)&&!Number.isFinite(next))throw tilemapInvalid('Invalid gap.');
    this._gap = next;
    this.markDirty();
  }

  get cells(): Int16Array {
    return this._cells;
  }

  set cells(value: Int16Array) {
    this.validateDimensions(this.columns,this.rows,value);
    validateAtlasCells(value,tilemapState(this).atlas);
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
    validateAtlasCells(this._cells,tilemapState(this)?.atlas??null);
    this._version++;
    invalidateTilemap(this);
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
      if((tilemapState(this).atlas||tilemapState(this).explicitChunks)&&(!Number.isSafeInteger(column)||!Number.isSafeInteger(row)))throw tilemapInvalid('Chunk coordinates must be integers.');
      validateAtlasCell(value,tilemapState(this).atlas);
      const index = this.index(column, row);
      if (this._cells[index] !== value) {
        this._cells[index] = value;
        this._version++;dirtyTile(this,column,row);
      }
    }
    return this;
  }

  clear(value = 0): this {
    validateAtlasCell(value,tilemapState(this).atlas);
    this._cells.fill(value);
    this.markDirty();
    return this;
  }

  resize(columns: number, rows: number): this {
    const nextColumns = Math.max(1, Math.floor(columns));
    const nextRows = Math.max(1, Math.floor(rows));
    if (nextColumns === this.columns && nextRows === this.rows) return this;

    this.validateDimensions(nextColumns,nextRows,{length:nextColumns*nextRows});
    const state=tilemapState(this),transforms=new Map<number,TilemapCellTransform>();
    for(const [index,transform]of state.transforms){const column=index%this.columns,row=Math.floor(index/this.columns);if(column<nextColumns&&row<nextRows)transforms.set(row*nextColumns+column,transform);}
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
    state.transforms=transforms;
    this.markDirty();
    return this;
  }

  private validateDimensions(columns:number,rows:number,cells:ArrayLike<number>=this.cells):void {
    const s=tilemapState(this);validateMapSize(columns,rows,cells,!!s.atlas||s.explicitChunks||s.transforms.size>0);
  }
  private validateGeometry():void {
    if(![this.cellWidth,this.cellHeight,this.originX,this.originY,this.gap].every(Number.isFinite)||this.cellWidth<=0||this.cellHeight<=0)throw tilemapInvalid('Chunk/atlas geometry must be finite with positive cell size.');
  }
  setAtlas(atlas:TilemapAtlasOptions|null):this {
    const next=checkedAtlas(atlas),state=tilemapState(this);
    if(next){validateMapSize(this.columns,this.rows,this.cells,true);this.validateGeometry();validateAtlasCells(this.cells,next);}
    state.atlas=next;this.markDirty();return this;
  }
  setCellTransform(column:number,row:number,transform:TilemapCellTransform):this {
    if(!cellTransforms.includes(transform))throw tilemapInvalid('Unknown tile transform.');
    validateMapSize(this.columns,this.rows,this.cells,true);this.validateGeometry();
    if(!Number.isInteger(column)||!Number.isInteger(row)||!this.contains(column,row))return this;
    const state=tilemapState(this),index=this.index(column,row);
    if((state.transforms.get(index)??'none')===transform)return this;
    if(transform==='none')state.transforms.delete(index);else state.transforms.set(index,transform);
    this._version++;dirtyTile(this,column,row);return this;
  }
  getCellTransform(column:number,row:number):TilemapCellTransform {
    return this.contains(column,row)?tilemapState(this).transforms.get(this.index(column,row))??'none':'none';
  }

  override clone(): Tilemap2DComponent {
    const state=tilemapState(this),copy=new Tilemap2DComponent({
      columns: this.columns,
      rows: this.rows,
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      originX: this.originX,
      originY: this.originY,
      gap: this.gap,
      cells: this.cells,
      palette: this.palette,
      atlas:state.atlas,
      ...(state.explicitChunks?{chunkSize:state.chunkSize,maxResidentChunks:state.maxResident}:{}),
    });
    tilemapState(copy).transforms=new Map(state.transforms);
    return copy;
  }
}
