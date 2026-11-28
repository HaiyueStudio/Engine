import {GuiPaintParameters, type GuiClipRect} from './GuiPaintParameters';
import { bitmapKerningKey, type BitmapFontChar, type BitmapFontData } from '../../font/BitmapFontData';
import { GUI_TEXTURED_VERTEX_LAYOUT } from './GuiVertexLayout';
import {guiFontCharacters,guiFontGlyph,guiFontGlyphIsColored,guiFontLayoutState} from './GuiTextGlyphs';
import {snapshotGuiCommand} from './GuiCommandCache';
import {GuiVertexChanges,forgetGuiVertexChanges} from './GuiVertexChanges';
import {sameGuiInputs} from '../GuiInvalidationState';

const VERTICES_PER_GLYPH = 6;

export interface GuiTextCommand {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  color: [number, number, number, number];
  multiline?: boolean;
  verticalAlign?: 'top' | 'center';
  wrap?: boolean;
  lineHeight?: number;
  lineHeightPixels?: number;
  overflow?: 'clip' | 'ellipsis';
  clip?: GuiClipRect;
}

export class GuiTextBatch {
  readonly parameters = new GuiPaintParameters();
  private clipIndices: number[] = [];
  readonly commands: GuiTextCommand[] = [];
  readonly commandRanges: {first: number; count: number}[] = [];
  vertexData = new Float32Array(0);
  vertexCount = 0;
  version = 0;
  dirty = true;
  private scratch = new Float32Array(0);
  private retainedVertexCount = 0;
  private retained:{command:GuiTextCommand;layout:ReturnType<typeof layoutText>;first:number;count:number}[]=[];
  private fontState:readonly unknown[]=[];
  private forceUpload=false;

  clear(): void {
    this.commands.length = 0;
    this.commandRanges.length = 0;
    this.vertexCount = 0;
    this.dirty = true;
  }

  addText(command: GuiTextCommand): void {
    if (!command.text || command.width <= 0 || command.height <= 0 || command.color[3] <= 0) return;
    this.commands.push(command);
    this.dirty = true;
  }

  rebuild(font: BitmapFontData): void {
    try{this.rebuildGeometry(font);}catch(error){this.retained=[];this.fontState=[];this.forceUpload=true;this.dirty=true;forgetGuiVertexChanges(this);throw error;}
  }
  private rebuildGeometry(font:BitmapFontData):void {
    this.parameters.begin();
    const indices=this.commands.map(c=>this.parameters.clip(c.clip)); this.parameters.finish();
    const base=this.version,changes=new GuiVertexChanges(),state=this.commands.length?guiFontLayoutState(font,this.commands.reduce((n,c)=>n+c.text.length,0)):[];
    const stable=sameGuiInputs(state,this.fontState);
    const next:typeof this.retained=[];let layouts=0,rebuilt=0;
    this.commandRanges.length = 0;
    let first = 0;
    for(let i=0;i<this.commands.length;i++){
      const command=this.commands[i]!,previous=this.retained[i];
      const reuse=stable&&previous&&sameTextLayout(previous.command,command);
      const layout=reuse?previous.layout:layoutText(command,font);if(!reuse)layouts++;
      const count = layout.glyphs.length * VERTICES_PER_GLYPH;
      this.commandRanges.push({first, count});
      next.push({command:previous&&sameTextLayout(previous.command,command)&&previous.command.color.every((v,n)=>v===command.color[n])?previous.command:snapshotGuiCommand(command),layout,first,count});first+=count;
    }
    const vertexCount = first;
    const requiredFloats = vertexCount * GUI_TEXTURED_VERTEX_LAYOUT.floatsPerVertex;
    if(this.vertexData.length<requiredFloats){const data=new Float32Array(nextCapacity(requiredFloats));data.set(this.vertexData);this.vertexData=data;}
    const glyphFloats=VERTICES_PER_GLYPH*GUI_TEXTURED_VERTEX_LAYOUT.floatsPerVertex;
    if(vertexCount&&this.scratch.length<glyphFloats)this.scratch=new Float32Array(glyphFloats);
    if(this.forceUpload)changes.add(0,requiredFloats*4);
    let changed=this.forceUpload||vertexCount!==this.retainedVertexCount;
    for (let i = 0; i < next.length; i++) {
      const entry=next[i]!,previous=this.retained[i],{layout,command}=entry;
      const fixed=indices[i]===this.clipIndices[i]&&previous?.first===entry.first&&sameTextPaint(previous.command,command,previous.layout,layout);
      // Negative RGB marks atlas-colored glyphs; alpha still carries caller opacity.
      for(let j=0;j<layout.glyphs.length;j++){
        const glyph=layout.glyphs[j]!;
        if(fixed&&sameGlyph(previous.layout.glyphs[j],glyph))continue;
        const offset=(entry.first+j*VERTICES_PER_GLYPH)*GUI_TEXTURED_VERTEX_LAYOUT.floatsPerVertex;
        pushGlyph(this.scratch, 0, glyph.x0, glyph.y0, glyph.x1, glyph.y1,
          glyph.u0, glyph.v0, glyph.u1, glyph.v1, glyph.colored ? [-1,-1,-1,command.color[3]] : command.color,
          layout.clipX0, layout.clipY0, layout.clipX1, indices[i] ? -indices[i]! : layout.clipY1);
        rebuilt+=VERTICES_PER_GLYPH;
        let different=false;for(let n=0;n<glyphFloats&&!different;n++)different=this.vertexData[offset+n]!==this.scratch[n];
        if(different){this.vertexData.set(this.scratch,offset);changes.add(offset*4,glyphFloats*4);changed=true;}
      }
    }
    if(changed)this.version++;
    this.forceUpload=false;
    this.clipIndices=indices;
    this.retained=next;this.fontState=state??[];
    this.retainedVertexCount = this.vertexCount = vertexCount;
    changes.commit(this,base,this.version,{commands:this.commands.length,layouts,vertices:rebuilt});
    this.dirty = false;
  }
}

function sameTextLayout(a:GuiTextCommand,b:GuiTextCommand):boolean {
  return a.text===b.text&&a.x===b.x&&a.y===b.y&&a.width===b.width&&a.height===b.height&&a.fontSize===b.fontSize&&a.multiline===b.multiline&&a.verticalAlign===b.verticalAlign&&a.wrap===b.wrap&&a.lineHeight===b.lineHeight&&a.lineHeightPixels===b.lineHeightPixels&&a.overflow===b.overflow&&
    (a.clip===b.clip||!!(a.clip&&b.clip&&a.clip.x===b.clip.x&&a.clip.y===b.clip.y&&a.clip.width===b.clip.width&&a.clip.height===b.clip.height));
}
function sameTextPaint(a:GuiTextCommand,b:GuiTextCommand,x:ReturnType<typeof layoutText>,y:ReturnType<typeof layoutText>):boolean {
  return a.color.every((v,i)=>v===b.color[i])&&x.clipX0===y.clipX0&&x.clipY0===y.clipY0&&x.clipX1===y.clipX1&&x.clipY1===y.clipY1;
}
function sameGlyph(a:LaidOutGlyph|undefined,b:LaidOutGlyph):boolean {return !!a&&a.colored===b.colored&&a.x0===b.x0&&a.y0===b.y0&&a.x1===b.x1&&a.y1===b.y1&&a.u0===b.u0&&a.v0===b.v0&&a.u1===b.u1&&a.v1===b.v1;}

export function measureGuiTextWidth(text: string, font: BitmapFontData, fontSize: number): number {
  let maxWidth = 0;
  for (const line of text.split(/\r\n|[\r\n]/u)) {
    maxWidth = Math.max(maxWidth, measureGuiLineWidth(line, font, fontSize));
  }
  return maxWidth;
}

export interface GuiTextMeasurer {
  (text: string): number;
  readonly prefixWidths?: (text: string, offsets: readonly number[]) => Readonly<Float64Array>;
}

/** Private input metrics: one glyph walk, with the same fallback and kerning as drawing. */
export function createGuiTextMeasurer(source: BitmapFontData | null | (() => BitmapFontData | null), fontSize: number): GuiTextMeasurer {
  const resolve = typeof source === 'function' ? source : () => source;
  let cached: {text: string; offsets: readonly number[]; state: readonly unknown[]; widths: Float64Array} | undefined;
  return Object.assign((text: string): number => {
    const font = resolve(); return font ? measureGuiTextWidth(text, font, fontSize) : text.length * fontSize * 0.55;
  }, {prefixWidths(text: string, offsets: readonly number[]): Readonly<Float64Array> {
    const font = resolve(), state = font ? guiFontLayoutState(font, text.length) : [null];
    if (cached && cached.text === text && cached.offsets === offsets && sameGuiInputs(state,cached.state)) return cached.widths;
    const widths = new Float64Array(offsets.length);
    let next = 0;
    while (next < offsets.length && offsets[next] === 0) widths[next++] = 0;
    if (font) measureGuiLineWidth(text, font, fontSize, (offset, width) => {
      while (next < offsets.length && offsets[next]! <= offset) widths[next++] = Math.max(0, width);
    });
    else for (; next < offsets.length; next++) widths[next] = Math.max(0, offsets[next]! * fontSize * 0.55);
    cached = state ? {text, offsets, state, widths} : undefined;
    return widths;
  }});
}

/** @internal Uses exactly the glyph advances, ink bounds, kerning and wrap of drawing. */
export function measureGuiTextBlock(text: string, font: BitmapFontData, fontSize: number, width: number, wrap: boolean): {width: number; height: number} {
  const result = layoutText({text, x: 0, y: 0, width, height: Infinity, fontSize, color: [1, 1, 1, 1], multiline: wrap, wrap, verticalAlign: 'top'}, font);
  return {width: result.advanceWidth, height: text ? result.blockHeight : 0};
}

function measureGuiLineWidth(text: string, font: BitmapFontData, fontSize: number, advance?: (offset: number, width: number) => void): number {
  const scale = fontSize / font.size;
  let width = 0;
  let previousCode: number | null = null;
  let offset = 0;
  for (const char of guiFontCharacters(text,font)) {
    const code = char.codePointAt(0);
    const glyph = guiFontGlyph(char,font);
    if (code !== undefined && glyph) {
      if (previousCode !== null) width += (font.kernings.get(bitmapKerningKey(previousCode, code)) ?? 0) * scale;
      width += glyph.xadvance * scale;
      previousCode = code;
    }
    offset += char.length; advance?.(offset, width);
  }
  return width;
}

interface LaidOutGlyph {
  colored: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

function layoutText(command: GuiTextCommand, font: BitmapFontData): {
  glyphs: LaidOutGlyph[];
  clipX0: number;
  clipY0: number;
  clipX1: number;
  clipY1: number;
  advanceWidth: number;
  blockHeight: number;
} {
  const scale = command.fontSize / font.size;
  const clip = command.clip ?? { x: command.x, y: command.y, width: command.width, height: command.height };
  const clipX0 = clip.x;
  const clipY0 = clip.y;
  const clipX1 = clip.x + clip.width;
  const clipY1 = clip.y + clip.height;
  const lineStep = command.lineHeightPixels ?? (command.lineHeight ?? font.lineHeight) * scale;
  let x = command.x;
  const centerBlock = command.multiline && command.verticalAlign === 'center';
  let baselineY = command.y + (command.multiline || command.verticalAlign === 'top' ? 0 : (command.height - font.lineHeight * scale) * 0.5);
  let previousCode: number | null = null;
  const glyphs: LaidOutGlyph[] = [];
  let advanceWidth = 0;

  const text=command.overflow==='ellipsis'&&!command.multiline?ellipsizeGuiText(command.text,font,command.fontSize,command.width):command.text;
  for (const char of guiFontCharacters(text,font)) {
    if (char === '\n' || char === '\r' || char === '\r\n') {
      if (!command.multiline) break;
      advanceWidth = Math.max(advanceWidth, x - command.x);
      x = command.x;
      baselineY += lineStep;
      previousCode = null;
      if (!centerBlock && baselineY > clipY1) break;
      continue;
    }
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    const glyph: BitmapFontChar | undefined = guiFontGlyph(char,font);
    if (!glyph) continue;
    const advance = glyph.xadvance * scale;

    if (previousCode !== null) {
      x += (font.kernings.get(bitmapKerningKey(previousCode, code)) ?? 0) * scale;
    }

    // Atlas quads include transparent padding; wrapping follows logical advances,
    // and clipping a parent must not change a child's line breaks.
    if (command.wrap && x + advance > command.x + command.width + 1e-6 && x > command.x) {
      advanceWidth = Math.max(advanceWidth, x - command.x);
      x = command.x;
      baselineY += lineStep;
      previousCode = null;
      if (!centerBlock && baselineY > clipY1) break;
    }
    const nextX0 = x + glyph.xoffset * scale;
    const nextY0 = baselineY + glyph.yoffset * scale;
    const nextX1 = nextX0 + glyph.width * scale;
    const nextY1 = nextY0 + glyph.height * scale;
    const u0 = glyph.x / font.scaleW;
    const v0 = glyph.y / font.scaleH;
    const u1 = (glyph.x + glyph.width) / font.scaleW;
    const v1 = (glyph.y + glyph.height) / font.scaleH;

    if ((centerBlock || (nextY1 >= clipY0 && nextY0 <= clipY1)) && nextX1 >= clipX0 && nextX0 <= clipX1) {
      glyphs.push({ x0: nextX0, y0: nextY0, x1: nextX1, y1: nextY1, u0, v0, u1, v1, colored: guiFontGlyphIsColored(char,font) });
    }
    x += advance;
    advanceWidth = Math.max(advanceWidth, x - command.x);
    previousCode = code;

    if (!command.wrap && x > clipX1) break;
  }
  if (centerBlock) {
    // Measure all wrapped lines before centering; overflowing text stays top-aligned.
    const blockHeight = baselineY - command.y + font.lineHeight * scale;
    const shift = Math.max(0, (command.height - blockHeight) * 0.5);
    for (const glyph of glyphs) { glyph.y0 += shift; glyph.y1 += shift; }
    return { glyphs: glyphs.filter(g => g.y1 >= clipY0 && g.y0 <= clipY1), clipX0, clipY0, clipX1, clipY1, advanceWidth, blockHeight };
  }
  return { glyphs, clipX0, clipY0, clipX1, clipY1, advanceWidth, blockHeight: baselineY - command.y + font.lineHeight * scale };
}

function pushGlyph(
  data: Float32Array,
  offset: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  color: [number, number, number, number],
  clipX0: number,
  clipY0: number,
  clipX1: number,
  clipY1: number,
): number {
  offset = writeGlyphVertex(data, offset, x0, y0, u0, v0, color, clipX0, clipY0, clipX1, clipY1);
  offset = writeGlyphVertex(data, offset, x1, y0, u1, v0, color, clipX0, clipY0, clipX1, clipY1);
  offset = writeGlyphVertex(data, offset, x0, y1, u0, v1, color, clipX0, clipY0, clipX1, clipY1);
  offset = writeGlyphVertex(data, offset, x1, y0, u1, v0, color, clipX0, clipY0, clipX1, clipY1);
  offset = writeGlyphVertex(data, offset, x1, y1, u1, v1, color, clipX0, clipY0, clipX1, clipY1);
  offset = writeGlyphVertex(data, offset, x0, y1, u0, v1, color, clipX0, clipY0, clipX1, clipY1);
  return offset;
}

function writeGlyphVertex(
  data: Float32Array,
  offset: number,
  x: number,
  y: number,
  u: number,
  v: number,
  color: [number, number, number, number],
  clipX0: number,
  clipY0: number,
  clipX1: number,
  clipY1: number,
): number {
  const base = offset;
  const fields = GUI_TEXTURED_VERTEX_LAYOUT.floatOffsets;
  data[base + fields.position] = x;
  data[base + fields.position + 1] = y;
  data[base + fields.uv] = u;
  data[base + fields.uv + 1] = v;
  data.set(color, base + fields.color);
  data[base + fields.clip] = clipX0;
  data[base + fields.clip + 1] = clipY0;
  data[base + fields.clip + 2] = clipX1;
  data[base + fields.clip + 3] = clipY1;
  return base + GUI_TEXTURED_VERTEX_LAYOUT.floatsPerVertex;
}

function nextCapacity(required: number): number {
  let capacity = 1024;
  while (capacity < required) capacity *= 2;
  return capacity;
}

export const GUI_TEXT_FLOATS_PER_VERTEX = /* @__PURE__ */ (() => GUI_TEXTURED_VERTEX_LAYOUT.floatsPerVertex)();
export const GUI_TEXT_VERTICES_PER_GLYPH = VERTICES_PER_GLYPH;

/** Truncates extended graphemes in one metrics walk, retaining the original font's kerning. */
export function ellipsizeGuiText(text:string,font:BitmapFontData,fontSize:number,width:number):string {
  const line=text.split(/\r\n|[\r\n]/u)[0]??'';if(measureGuiTextWidth(line,font,fontSize)<=width)return line;
  const marker=font.chars.has(0x2026)?'…':'...',limit=width-measureGuiTextWidth(marker,font,fontSize);if(limit<0)return '';
  const scale=fontSize/font.size;let result='',advance=0,previous:number|undefined;
  for(const char of guiFontCharacters(line,font)){const code=char.codePointAt(0),glyph=guiFontGlyph(char,font);if(code===undefined||!glyph)continue;const next=advance+(previous!==undefined?(font.kernings.get(bitmapKerningKey(previous,code))??0)*scale:0)+glyph.xadvance*scale;if(next>limit)break;advance=next;result+=char;previous=code;}
  return result+marker;
}
