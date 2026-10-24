import type {RuntimeLayoutDocument} from '../../layout/parameterized/runtime-types.js';
import type {ProductionGlyph, ProductionGlyphRun, ProductionTextRequest, ProductionTextResult} from './types.js';
import {snapshotPlainTextData} from '../PlainTextData.js';
import {textContent,textClusters} from '../parameterized/TextContent.js';

export class ProductionTextError extends Error {
  override readonly name = 'ProductionTextError';
  constructor(readonly code: string, readonly path: string, message: string) {super(`${message} (${path})`);}
}
export function textFail(code: string, path: string, message: string): never {throw new ProductionTextError(code, path, message);}
/** Requests/style metadata only: opaque platform images are never cloned or frozen. */
export function snapshotTextData(value: unknown, path: string): ReturnType<typeof snapshotPlainTextData> {
  return snapshotPlainTextData(value, path, (path, message, limit) => textFail(limit ? 'E_HYA_RUNTIME_LIMIT' : 'E_HYA_RUNTIME_TEXT', path, message));
}
function vector(value: unknown, length: number, path: string, size = false): readonly number[] {
  if (!Array.isArray(value) || value.length !== length || value.some(number => typeof number !== 'number' || !Number.isFinite(number)) || size && value.some(number => number < 0)) textFail('E_HYA_RUNTIME_TEXT', path, 'invalid finite geometry tuple');
  return Object.freeze([...value]);
}
function rect(value: unknown, path: string): readonly [number, number, number, number] {
  const result = vector(value, 4, path); if (result[2]! < 0 || result[3]! < 0) textFail('E_HYA_RUNTIME_TEXT', path, 'negative rectangle extent'); return result as readonly [number, number, number, number];
}
function integer(value: number, path: string): void {if (!Number.isSafeInteger(value) || value < 0) textFail('E_HYA_RUNTIME_TEXT', path, 'expected a nonnegative safe integer');}
function dense(value: readonly unknown[], path: string): void {for (let index = 0; index < value.length; index++) if (!(index in value)) textFail('E_HYA_RUNTIME_TEXT', path, 'sparse host result collections are invalid');}
function offset(value: number, text: string, path: string): void {
  integer(value, path);
  if (value > text.length || value > 0 && value < text.length && /[\uD800-\uDBFF]/u.test(text[value - 1]!) && /[\uDC00-\uDFFF]/u.test(text[value]!)) textFail('E_HYA_RUNTIME_TEXT', path, 'offset is outside the text or splits a UTF-16 surrogate pair');
}
export function snapshotTextResult(value: ProductionTextResult, request: ProductionTextRequest, document: RuntimeLayoutDocument): ProductionTextResult {
  const path = '$.host.fonts.shape';
  if (!value || value.block !== request.block) textFail('E_HYA_RUNTIME_TEXT', path, 'font result does not match the requested block');
  const size = vector(value.size, 2, `${path}.size`, true) as readonly [number, number];
  const contentSize = vector(value.contentSize, 2, `${path}.contentSize`, true) as readonly [number, number];
  for (const [index, name] of ['width', 'height'].entries()) {
    const constraint = request.constraints?.[name as 'width' | 'height'];
    if (constraint && (constraint.mode === 'exact' && size[index] !== constraint.value || constraint.mode === 'at-most' && size[index]! > constraint.value!)) textFail('E_HYA_RUNTIME_TEXT', `${path}.size`, 'font result violates its requested box');
  }
  const block = document.textBlocks.find(block => block.id === request.block)!;
  const text = textContent(block, request.strings);
  if (!Array.isArray(value.runs) || !Array.isArray(value.lines) || !Array.isArray(value.controls) || value.runs.length > 1_000_000 || value.lines.length > 250_000 || value.controls.length > 1_000_000) textFail('E_HYA_RUNTIME_LIMIT', path, 'invalid or excessive text result collections');
  dense(value.runs, path + '.runs'); dense(value.lines, path + '.lines'); dense(value.controls, path + '.controls');
  const fonts = new Set(document.assets.filter(asset => asset.kind === 'font').map(asset => asset.id));
  const styles = new Map(document.textStyles.map(style => [style.id, style])); let glyphs = 0, commands = 0;
  const runs: ProductionGlyphRun[] = value.runs.map((run, runIndex) => {
    const p = `${path}.runs[${runIndex}]`, original = run?.style && styles.get(run.style.id);
    if (!run || !original || !fonts.has(run.font) || !Array.isArray(run.glyphs)) textFail('E_HYA_RUNTIME_TEXT', p, 'font run references an unknown style or font');
    dense(run.glyphs, p + '.glyphs');
    const expected = {...original, ...(request.styles?.[original.id] ?? {})};
    const style = snapshotTextData(run.style, p + '.style');
    if (JSON.stringify(style) !== JSON.stringify(snapshotTextData(expected, p + '.expectedStyle'))) textFail('E_HYA_RUNTIME_TEXT', p + '.style', 'font result uses stale style data');
    if (!run.style.fontAssets.includes(run.font)) textFail('E_HYA_RUNTIME_TEXT', p + '.font', 'font is outside the requested fallback chain');
    if ((glyphs += run.glyphs.length) > 1_000_000) textFail('E_HYA_RUNTIME_LIMIT', p, 'glyph ceiling exceeded');
    const output: ProductionGlyph[] = run.glyphs.map((glyph: ProductionGlyph, glyphIndex: number) => {
      if (!glyph || typeof glyph !== 'object') textFail('E_HYA_RUNTIME_TEXT', p, 'malformed glyph');
      const g = `${p}.glyphs[${glyphIndex}]`; integer(glyph.id, g + '.id'); offset(glyph.clusterUtf16, text, g + '.clusterUtf16');
      if (typeof glyph.sequence !== 'string' || !glyph.sequence.length || text.slice(glyph.clusterUtf16, glyph.clusterUtf16 + glyph.sequence.length) !== glyph.sequence) textFail('E_HYA_RUNTIME_TEXT', g + '.sequence', 'glyph cluster does not reference the committed logical text');
      if (!Number.isFinite(glyph.advance) || !Number.isFinite(glyph.opacity) || glyph.opacity < 0 || glyph.opacity > 1) textFail('E_HYA_RUNTIME_TEXT', g, 'invalid glyph advance or opacity');
      const bounds = rect(glyph.rect, g + '.rect'), transform = vector(glyph.transform, 6, g + '.transform') as ProductionGlyph['transform'];
      let paint: ProductionGlyph['paint'];
      if (glyph.paint?.kind === 'outline') {
        const outline = glyph.paint; let count = 0;
        if (typeof outline.commands !== 'string' || !/^[MLCQZ]*$/u.test(outline.commands) || !Array.isArray(outline.values)) textFail('E_HYA_RUNTIME_TEXT', g + '.paint', 'unsupported glyph outline');
        for (const command of outline.commands) count += command === 'M' || command === 'L' ? 2 : command === 'Q' ? 4 : command === 'C' ? 6 : 0;
        if (count !== outline.values.length || outline.values.some((number: number) => !Number.isFinite(number))) textFail('E_HYA_RUNTIME_TEXT', g + '.paint', 'outline command/value mismatch');
        if ((commands += outline.commands.length) > 1_000_000) textFail('E_HYA_RUNTIME_LIMIT', g + '.paint', 'outline command ceiling exceeded');
        paint = Object.freeze({kind: 'outline', commands: outline.commands, values: Object.freeze([...outline.values])});
      } else if (glyph.paint?.kind === 'bitmap') {
        const source = glyph.paint.source;
        if (!source || source.value === null || source.value === undefined) textFail('E_HYA_RUNTIME_TEXT', g + '.paint.source', 'missing real glyph bitmap');
        integer(source.generation, g + '.paint.source.generation'); integer(source.bytes, g + '.paint.source.bytes');
        paint = Object.freeze({kind: 'bitmap', source: Object.freeze({value: source.value, generation: source.generation, bytes: source.bytes}), uv: vector(glyph.paint.uv, 4, g + '.paint.uv') as readonly [number, number, number, number]});
      } else textFail('E_HYA_RUNTIME_TEXT', g + '.paint', 'glyph needs real outline or bitmap paint');
      return Object.freeze({id: glyph.id, clusterUtf16: glyph.clusterUtf16, sequence: glyph.sequence, rect: bounds, advance: glyph.advance, transform, opacity: glyph.opacity, paint});
    });
    return Object.freeze({font: run.font, style: style as unknown as ProductionGlyphRun['style'], glyphs: Object.freeze(output)});
  });
  const lines = value.lines.map((line, index) => {if (!line) textFail('E_HYA_RUNTIME_TEXT', path + '.lines', 'malformed text line'); offset(line.startUtf16, text, `${path}.lines[${index}].start`); offset(line.endUtf16, text, `${path}.lines[${index}].end`); if (line.endUtf16 < line.startUtf16) textFail('E_HYA_RUNTIME_TEXT', path + '.lines', 'inverted line range'); return Object.freeze({rect: rect(line.rect, path + '.lines'), startUtf16: line.startUtf16, endUtf16: line.endUtf16});});
  const controls = value.controls.map(control => {
    if (!control || !['selection', 'cursor'].includes(control.kind)) textFail('E_HYA_RUNTIME_TEXT', path + '.controls', 'unknown text control');
    if (control.radius !== undefined && (!Number.isFinite(control.radius) || control.radius < 0)) textFail('E_HYA_RUNTIME_TEXT', path + '.controls.radius', 'invalid finite control radius');
    return Object.freeze({kind: control.kind, rect: rect(control.rect, path + '.controls'), ...(control.radius === undefined ? {} : {radius: control.radius})});
  });
  let editing:ProductionTextResult['editing'];
  if(value.editing!==undefined){
    const e=value.editing,block=document.textBlocks.find(b=>b.id===request.block)!,boundaries=new Set([0,...textClusters(block,request.strings).map(c=>c.end)]);
    if(!e||e.text!==text||!Array.isArray(e.carets)||!Array.isArray(e.cells))textFail('E_HYA_RUNTIME_TEXT',path+'.editing','editing geometry must address the same shaped text');
    if(e.carets.length>boundaries.size||e.cells.length>1_000_000)textFail('E_HYA_RUNTIME_LIMIT',path+'.editing','editing geometry exceeds existing grapheme/glyph ceilings');dense(e.carets,path+'.editing.carets');dense(e.cells,path+'.editing.cells');
    const line=(v:number)=>{integer(v,path+'.editing.line');if(v>=lines.length)textFail('E_HYA_RUNTIME_TEXT',path+'.editing.line','editing line does not exist');};let previous=-1;
    const carets=e.carets.map(c=>{if(!c||!boundaries.has(c.offset)||c.offset<=previous)textFail('E_HYA_RUNTIME_TEXT',path+'.editing.offset','caret offsets must be unique ordered grapheme boundaries');line(c.line);previous=c.offset;return Object.freeze({offset:c.offset,line:c.line,rect:rect(c.rect,path+'.editing.caret')});});
    const cells=e.cells.map(c=>{if(!c||!boundaries.has(c.start)||!boundaries.has(c.end)||c.end<=c.start)textFail('E_HYA_RUNTIME_TEXT',path+'.editing.range','editing cell must use nonempty grapheme boundaries');line(c.line);return Object.freeze({start:c.start,end:c.end,line:c.line,rect:rect(c.rect,path+'.editing.cell')});});
    editing=Object.freeze({text:e.text,carets:Object.freeze(carets),cells:Object.freeze(cells)});
  }
  return Object.freeze({...(editing?{editing}:{}),block: value.block, size, contentSize, runs: Object.freeze(runs), lines: Object.freeze(lines), controls: Object.freeze(controls)});
}
