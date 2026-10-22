import {computeNineSlicePatches, type NineSlicePatch} from '../../geometry/NineSlice';
import {GuiDirtyFlags} from '../GuiTypes';
import type {GuiNineSliceOptions, GuiSkin} from '../GuiThemeTypes';
import {GuiImage} from './GuiImage';

function capture(options: GuiNineSliceOptions): GuiNineSliceOptions {
  const pixelRatio = options.pixelRatio ?? 1;
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) throw new RangeError('Nine-slice pixel ratio must be positive.');
  computeNineSlicePatches({width: 0, height: 0, sourceWidth: options.sourceWidth, sourceHeight: options.sourceHeight, cuts: options.cuts, ...(options.uv ? {uv: options.uv} : {})});
  const insets = options.contentInsets;
  if (insets && Object.values(insets).some(value => !Number.isFinite(value) || value < 0)) throw new RangeError('Invalid nine-slice content insets.');
  return Object.freeze({...options, cuts: Object.freeze([...options.cuts]) as typeof options.cuts,
    ...(options.uv ? {uv: Object.freeze([...options.uv]) as typeof options.uv} : {}),
    ...(insets ? {contentInsets: Object.freeze({...insets})} : {})});
}

/** Borrows its texture; only the normal GUI image renderer owns generated uploads. */
export class GuiNineSlice extends GuiImage {
  static override readonly themeControlType: string = 'GuiNineSlice';
  private skin: GuiNineSliceOptions;

  constructor(options: GuiNineSliceOptions) {
    const captured = capture(options), ratio = captured.pixelRatio ?? 1;
    super({...options, width: options.width ?? options.sourceWidth / ratio, height: options.height ?? options.sourceHeight / ratio,
      uv: [...(options.uv ?? [0, 0, 1, 1])] as [number, number, number, number]});
    this.skin = captured;
  }

  get patches(): readonly NineSlicePatch[] {
    const ratio = this.skin.pixelRatio ?? 1;
    return computeNineSlicePatches({width: this.rect.width * ratio, height: this.rect.height * ratio,
      sourceWidth: this.skin.sourceWidth, sourceHeight: this.skin.sourceHeight, cuts: this.skin.cuts, uv: this.uv})
      .map(patch => ({...patch, rect: {x: patch.rect.x / ratio, y: patch.rect.y / ratio, width: patch.rect.width / ratio, height: patch.rect.height / ratio}}));
  }

  setSkin(options: GuiNineSliceOptions): void {
    const next = capture(options);
    this.skin = next;
    this.setSource(next.source);
    this.setUv(next.uv ? [...next.uv] : [0, 0, 1, 1]);
    this.setTint(next.tint ?? '#ffffff');
    this.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
  }

  override getResolvedStyle(): GuiSkin {
    const resolved = super.getResolvedStyle();
    if (resolved.contentInsets) return resolved;
    const ratio = this.skin.pixelRatio ?? 1;
    const [left, top, right, bottom] = this.skin.cuts;
    return {...resolved, contentInsets: this.skin.contentInsets ?? {left: left / ratio, top: top / ratio, right: right / ratio, bottom: bottom / ratio}};
  }
}
