import {createNativeGlyphPaintResolver,rememberNativeGlyphPaint} from './NativeGlyphPaint.js';
import {rememberTextPaintSequence,textPaintSequence} from '../parameterized/ProductionTextPaintIdentity.js';
import {createProductionTextGeometry,productionLogicalLines,productionTextGeometryForPose} from '../parameterized/ProductionTextGeometry.js';
import {loadAnimationOutlineFont} from '../../AnimationOpenType.js';
import type {AnimationOutlineFont} from '../../AnimationTextRasterizer.js';
import type {LayoutAssetHandle, LayoutAssetOwner} from '../../layout/parameterized/AssetOwner.js';
import type {RuntimeLayoutDocument} from '../../layout/parameterized/runtime-types.js';
import {TextEvaluator} from '../parameterized/TextEvaluator.js';
import {textClusters, textContent} from '../parameterized/TextContent.js';
import type {RuntimeFontAsset, RuntimeGlyphMetric, RuntimeTextBlock} from '../parameterized/runtime-types.js';
import type {ProductionFontPort, ProductionGlyphRun, ProductionTextRequest, ProductionTextResult} from './types.js';
import {textFail} from './snapshot.js';

/** Uses the existing asset owner, lazy OpenType preparation and original text evaluator. */
export function createProductionOutlineFontPort(assets: LayoutAssetOwner, options: Readonly<{nativeGlyphPaint?: boolean}> = {}): ProductionFontPort {
  return Object.freeze({async acquire(document: RuntimeLayoutDocument, signal: AbortSignal) {
    const handles = new Set<LayoutAssetHandle>(), fonts = new Map<string, AnimationOutlineFont>();
    let retired = false;
    const release = () => {if (retired) return; retired = true; const failures: unknown[] = []; for (const handle of handles) {try {handle.release();} catch (error) {failures.push(error);}} handles.clear(); if (failures.length) throw new AggregateError(failures, 'Font handle release failed.');};
    const cancelled = () => {if (retired || signal.aborted) textFail('E_HYA_RUNTIME_ABORTED', '$.host.fonts', 'font preparation was retired');};
    try {
      cancelled();
      const declaredFonts = new Map(document.assets.filter((asset): asset is RuntimeFontAsset & typeof asset => asset.kind === 'font').map(asset => [asset.id, asset]));
      for (const asset of declaredFonts.values()) {
        cancelled();
        const handle = await assets.load(asset.id, {signal});
        if (retired || signal.aborted) {handle.release(); cancelled();}
        handles.add(handle);
        const bytes = handle.bytes;
        const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ? bytes.buffer : bytes.slice().buffer as ArrayBuffer;
        const font = await loadAnimationOutlineFont(data); cancelled();
        if (!font?.glyphs || font.unitsPerEm !== asset.metrics.unitsPerEm) textFail('E_HYA_RUNTIME_HOST_PORT', `$.assets.${asset.id}`, 'font lacks indexed outlines or differs from compiled units-per-em');
        if (Object.keys(asset.metrics.axes ?? {}).length) textFail('E_HYA_RUNTIME_HOST_PORT', `$.assets.${asset.id}.metrics.axes`, 'this outline host needs an explicit variation-capable font port');
        const variations = (font as AnimationOutlineFont & {readonly tables?: Readonly<{fvar?: Readonly<{axes?: readonly unknown[]}>}>}).tables?.fvar;
        if (variations?.axes?.length) textFail('E_HYA_RUNTIME_HOST_PORT', `$.assets.${asset.id}.source`, 'variable font bytes require an explicit variation-capable font port even when compiled axes are omitted');
        const metrics = [asset.metrics.missingGlyph, ...Object.values(asset.metrics.glyphs), ...Object.values(asset.metrics.ligatures ?? {})];
        for (const metric of metrics) validateMetric(font, metric, asset.id);
        fonts.set(asset.id, font);
      }
      cancelled();
      const evaluator = new TextEvaluator(document, undefined, undefined, true);
      return Object.freeze({
        shape(request: ProductionTextRequest): ProductionTextResult {
          cancelled();
          const block = document.textBlocks.find(block => block.id === request.block);
          if (!block) textFail('E_HYA_RUNTIME_TEXT', '$.text.block', 'unknown text block');
          const clusters = textClusters(block, request.strings), fullText = textContent(block, request.strings);
          const updates = {...request,
            ...(request.selections ? {selections: Object.fromEntries(Object.entries(request.selections).map(([key, range]) => [key, [logicalOffset(range[0], clusters, fullText.length), logicalOffset(range[1], clusters, fullText.length)] as const]))} : {}),
            ...(request.cursors ? {cursors: Object.fromEntries(Object.entries(request.cursors).map(([key, value]) => [key, logicalOffset(value, clusters, fullText.length)]))} : {})};
          const pose = evaluator.evaluate(request.block, updates), runs: ProductionGlyphRun[] = [];
          for (const glyph of pose.glyphs) {
            if (textPaintSequence(glyph) === '') continue;
            const style = glyph.style!, font = fonts.get(glyph.fontAsset);
            const declared = declaredFonts.get(glyph.fontAsset);
            if (!declared || style.fontWeight !== declared.weight || style.fontStyle !== declared.style) textFail('E_HYA_RUNTIME_HOST_PORT', '$.text.font', 'synthetic font variants require an explicit matching prepared font');
            if (style.axes && Object.keys(style.axes).length) textFail('E_HYA_RUNTIME_HOST_PORT', `$.text.styles.${style.id}.axes`, 'axis requests require an explicit variation-capable font port');
            if (!font?.glyphs) textFail('E_HYA_RUNTIME_HOST_PORT', `$.assets.${glyph.fontAsset}`, 'font replacement must be prepared before shaping');
            const outline = font.glyphs.get(glyph.glyphId), path = outline.getPath(0, 0, style.fontSize);
            const bounds = outline.getBoundingBox(), scale = style.fontSize / font.unitsPerEm!, x = bounds.x1 * scale, y = -bounds.y2 * scale;
            const cosine = Math.cos(glyph.rotation), sine = Math.sin(glyph.rotation), a = cosine * glyph.scaleX, b = sine * glyph.scaleX, c = -sine * glyph.scaleY, d = cosine * glyph.scaleY;
            const tx = glyph.x - a * x - c * y, ty = glyph.y - b * x - d * y;
            const points = [[x, y], [bounds.x2 * scale, y], [x, -bounds.y1 * scale], [bounds.x2 * scale, -bounds.y1 * scale]].map(([x, y]) => [a * x! + c * y! + tx, b * x! + d * y! + ty]);
            const left = Math.min(...points.map(point => point[0]!)), top = Math.min(...points.map(point => point[1]!));
            let commands = ''; const values: number[] = [];
            for (const command of path.commands) {
              commands += command.type;
              if (command.type === 'C') values.push(command.x1!, command.y1!, command.x2!, command.y2!, command.x!, command.y!);
              else if (command.type === 'Q') values.push(command.x1!, command.y1!, command.x!, command.y!);
              else if (command.type === 'M' || command.type === 'L') values.push(command.x!, command.y!);
              else if (command.type !== 'Z') textFail('E_HYA_RUNTIME_TEXT', '$.font.outline', 'unsupported font outline command');
            }
            const output = rememberTextPaintSequence(Object.freeze({id: glyph.glyphId,
              clusterUtf16: clusters[glyph.logicalIndex]?.start ?? fullText.length, sequence: glyph.sequence,
              rect: [left, top, Math.max(...points.map(point => point[0]!)) - left, Math.max(...points.map(point => point[1]!)) - top] as const,
              advance: glyph.advance, transform: [a, b, c, d, tx, ty] as const, opacity: glyph.opacity,
              paint: Object.freeze({kind: 'outline' as const, commands, values: Object.freeze(values)})}),textPaintSequence(glyph));
            if (options.nativeGlyphPaint) rememberNativeGlyphPaint(output, createNativeGlyphPaintResolver(font, glyph.glyphId, style, textPaintSequence(glyph) ?? glyph.sequence, path));
            runs.push(Object.freeze({font: glyph.fontAsset, style, glyphs: Object.freeze([output])}));
          }
          const metricFonts=new Map(document.assets.filter((asset):asset is RuntimeFontAsset & typeof asset=>asset.kind==='font').map(asset=>[asset.id,asset]));
          const editing=block.input?(productionTextGeometryForPose(pose)??createProductionTextGeometry(pose.glyphs,pose.lines,clusters,metricFonts)):undefined;
          const offset=(logical:number)=>clusters[logical]?.start??fullText.length,lineRanges=editing?.lines??productionLogicalLines(pose.glyphs,pose.lines,clusters);
          return Object.freeze({...(editing?{editing:Object.freeze({text:fullText,carets:Object.freeze(editing.carets.map(c=>Object.freeze({...c,offset:offset(c.offset)}))),cells:Object.freeze(editing.cells.map(c=>Object.freeze({...c,start:offset(c.start),end:offset(c.end)})))})}:{}),block: request.block, size: [pose.width, pose.height] as const, contentSize: [pose.contentWidth, pose.contentHeight] as const,
            runs: Object.freeze(runs), lines: Object.freeze(pose.lines.map((line,index) => {
              const logical=lineRanges[index]!;
              return Object.freeze({rect: [line.x, line.y, line.width, line.height] as const, startUtf16:offset(logical.start),endUtf16:offset(logical.end)});
            })), controls: Object.freeze(pose.controls.map(control => Object.freeze({kind: control.kind, rect: [control.x, control.y, control.width, control.height] as const, ...(control.radius ? {radius: control.radius} : {})})))});
        },
        release() {if (retired) return; evaluator.dispose(); release();},
      });
    } catch (error) {release(); if (signal.aborted) textFail('E_HYA_RUNTIME_ABORTED', '$.host.fonts', 'font preparation was retired'); throw error;}
  }});
}
function validateMetric(font: AnimationOutlineFont, metric: RuntimeGlyphMetric, id: string): void {
  const glyph = font.glyphs!.get(metric.glyphId), bounds = glyph?.getBoundingBox();
  if (!glyph || !bounds || glyph.advanceWidth !== metric.advance || [bounds.x1, bounds.y1, bounds.x2, bounds.y2].some((value, index) => Math.abs(value - metric.bounds[index]!) > 1e-6)
    || Object.values(metric.axisAdvance ?? {}).some(value => value !== 0)) textFail('E_HYA_RUNTIME_TEXT', `$.assets.${id}.metrics`, 'compiled glyph metrics differ from the actual font');
}
function logicalOffset(value: number, clusters: ReturnType<typeof textClusters>, length: number): number {
  if (value === length) return clusters.length;
  const index = clusters.findIndex(cluster => cluster.start === value);
  if (index < 0) textFail('E_HYA_RUNTIME_TEXT', '$.text.selection', 'UTF-16 editing offset must be a shaped grapheme boundary');
  return index;
}
