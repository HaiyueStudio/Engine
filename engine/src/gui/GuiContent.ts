import type {GuiElement} from './components/GuiElement';
import type {GuiRect} from './GuiTypes';

/** Shared intrinsic/paint geometry for theme padding, skin borders and optional icons. */
export function guiContentMetrics(element: GuiElement, fallbackPadding: number, fontSize: number) {
  const skin = element.getResolvedStyle(), padding = skin.padding ?? fallbackPadding;
  const slice = skin.nineSlice, ratio = slice?.pixelRatio ?? 1;
  const insets = skin.contentInsets ?? slice?.contentInsets ?? (slice ? {
    left: slice.cuts[0] / ratio, top: slice.cuts[1] / ratio, right: slice.cuts[2] / ratio, bottom: slice.cuts[3] / ratio,
  } : {left: padding, top: padding, right: padding, bottom: padding});
  let iconWidth = 0, iconHeight = 0;
  if (skin.icon) {
    const source = 'texture' in skin.icon ? skin.icon.texture : skin.icon;
    const width = 'naturalWidth' in source ? source.naturalWidth : 'width' in source ? source.width : 0;
    const height = 'naturalHeight' in source ? source.naturalHeight : 'height' in source ? source.height : 0;
    const size = skin.iconSize ?? fontSize;
    const scale = width > 0 && height > 0 ? size / Math.max(width, height) : 0;
    iconWidth = scale ? width * scale : size; iconHeight = scale ? height * scale : size;
  }
  const gap = iconWidth > 0 ? skin.iconGap ?? 6 : 0;
  return {insets, iconWidth, iconHeight, gap, horizontal: insets.left + insets.right + iconWidth + gap, vertical: insets.top + insets.bottom};
}

export function guiContentBox(element: GuiElement, fallbackPadding: number, fontSize: number, r = element.rect) {
  const metrics = guiContentMetrics(element, fallbackPadding, fontSize), i = metrics.insets;
  const xScale = i.left + i.right > r.width ? r.width / (i.left + i.right) : 1;
  const yScale = i.top + i.bottom > r.height ? r.height / (i.top + i.bottom) : 1;
  const rect: GuiRect = {x: r.x + i.left * xScale, y: r.y + i.top * yScale,
    width: Math.max(0, r.width - (i.left + i.right) * xScale), height: Math.max(0, r.height - (i.top + i.bottom) * yScale)};
  const scale = metrics.iconWidth > 0 && metrics.iconHeight > 0 ? Math.min(1, rect.width / metrics.iconWidth, rect.height / metrics.iconHeight) : 0;
  const width = metrics.iconWidth * scale, height = metrics.iconHeight * scale;
  const icon = width > 0 ? {x: rect.x, y: rect.y + (rect.height - height) / 2, width, height} : null;
  const offset = Math.min(rect.width, width + (icon ? metrics.gap : 0));
  return {rect, icon, text: {...rect, x: rect.x + offset, width: Math.max(0, rect.width - offset)}};
}
