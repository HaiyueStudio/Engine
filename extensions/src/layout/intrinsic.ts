import type {LayoutStyle, LayoutTrack, Size} from './types.js';
import {edges} from './box.js';
import {resolveTracks} from './grid.js';

/** The shared content measurement stage; HYA supplies format/text/asset leaf metrics. */
export function intrinsicFlowSize(style: LayoutStyle, children: readonly Size[], containing: Size, checkpoint: () => void = () => {}): Size {
  const padding = edges(style.padding, containing.width, containing.height), border = edges(style.border, containing.width, containing.height);
  let width = 0, height = 0;
  if (style.display === 'grid') {
    const cg = typeof style.columnGap === 'number' ? style.columnGap : 0, rg = typeof style.rowGap === 'number' ? style.rowGap : 0;
    const preferred = (track: LayoutTrack): number => typeof track === 'number' ? track : 'min' in track ? typeof track.max === 'number' ? Math.max(typeof track.min === 'number' ? track.min : 0, track.max) : typeof track.min === 'number' ? track.min : 0 : 0;
    const columns: readonly LayoutTrack[] = style.columns ?? [{fr: 1}], rows: readonly LayoutTrack[] = style.rows ?? [{fr: 1}];
    const cw = columns.reduce<number>((sum, track) => sum + preferred(track), 0) + Math.max(0, columns.length - 1) * cg;
    const rh = rows.reduce<number>((sum, track) => sum + preferred(track), 0) + Math.max(0, rows.length - 1) * rg;
    width = resolveTracks(columns, cw, cg, 'gui-v1', checkpoint).reduce((sum, n) => sum + n, 0) + Math.max(0, columns.length - 1) * cg;
    height = resolveTracks(rows, rh, rg, 'gui-v1', checkpoint).reduce((sum, n) => sum + n, 0) + Math.max(0, rows.length - 1) * rg;
  } else {
    const row = !(style.direction ?? 'row').startsWith('column');
    const value = row ? style.columnGap : style.rowGap;
    const gap = typeof value === 'number' ? value : 0;
    const main = children.reduce((sum, size) => sum + (row ? size.width : size.height), 0) + Math.max(0, children.length - 1) * gap;
    const cross = Math.max(0, ...children.map(size => row ? size.height : size.width));
    width = row ? main : cross; height = row ? cross : main;
  }
  return {width: width + padding.left + padding.right + border.left + border.right, height: height + padding.top + padding.bottom + border.top + border.bottom};
}
