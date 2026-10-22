import type {BitmapFontData} from '../../font/BitmapFontData';
import type {GuiBatch} from './GuiBatch';
import type {GuiImageBatch, GuiImageGroup} from './GuiImageBatch';
import type {GuiTextBatch} from './GuiTextBatch';

type Layer = 0 | 1 | 2 | 3;
type Span = {start: number; end: number} & (
  {kind: 'shape'; batch: GuiBatch} | {kind: 'image'; batch: GuiImageBatch} |
  {kind: 'text'; batch: GuiTextBatch; font: BitmapFontData});
type Draw = {range: {first: number; count: number}} & (
  {kind: 'shape'; batch: GuiBatch} | {kind: 'image'; batch: GuiImageBatch; group: GuiImageGroup} |
  {kind: 'text'; batch: GuiTextBatch; font: BitmapFontData});

/** Retained painter order over shared batch buffers, without one GPU allocation per widget. */
export class GuiPaintPlan {
  private readonly spans: [Span[], Span[], Span[], Span[]] = [[], [], [], []];
  private readonly draws: [Draw[], Draw[], Draw[], Draw[]] = [[], [], [], []];
  clear(): void {for (const list of [...this.spans, ...this.draws]) list.length = 0;}
  shapes(batch: GuiBatch, start: number, layer: Layer): void {this.record({kind: 'shape', batch, start, end: batch.commands.length}, layer);}
  images(batch: GuiImageBatch, start: number, layer: Layer): void {this.record({kind: 'image', batch, start, end: batch.commands.length}, layer);}
  text(batch: GuiTextBatch, font: BitmapFontData | null, start: number, layer: Layer): void {if (font) this.record({kind: 'text', batch, font, start, end: batch.commands.length}, layer);}
  layer(layer: Layer): readonly Draw[] {return this.draws[layer];}

  compile(): void {
    for (const layer of [0, 1, 2, 3] as const) {
      this.draws[layer].length = 0;
      for (const span of this.spans[layer]) for (let index = span.start; index < span.end; index++) {
        if (span.kind === 'image') {
          const range = span.batch.commandRanges[index]!;
          this.append({kind: 'image', batch: span.batch, group: range.group, range: {first: range.first, count: range.count}}, layer);
        } else if (span.kind === 'text') this.append({kind: 'text', batch: span.batch, font: span.font, range: {...span.batch.commandRanges[index]!}}, layer);
        else this.append({kind: 'shape', batch: span.batch, range: {...span.batch.commandRanges[index]!}}, layer);
      }
    }
  }

  private record(span: Span, layer: Layer): void {
    if (span.end <= span.start) return;
    const list = this.spans[layer], previous = list[list.length - 1];
    if (previous?.kind === span.kind && previous.batch === span.batch && previous.end === span.start &&
        (span.kind !== 'text' || (previous.kind === 'text' && previous.font === span.font))) previous.end = span.end;
    else list.push(span);
  }

  private append(draw: Draw, layer: Layer): void {
    if (draw.range.count <= 0) return;
    const list = this.draws[layer], previous = list[list.length - 1];
    if (previous?.kind === draw.kind && previous.batch === draw.batch && previous.range.first + previous.range.count === draw.range.first &&
        (draw.kind !== 'image' || (previous.kind === 'image' && previous.group === draw.group)) &&
        (draw.kind !== 'text' || (previous.kind === 'text' && previous.font === draw.font))) previous.range.count += draw.range.count;
    else list.push(draw);
  }
}
