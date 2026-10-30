import type {GuiImageSource} from '../components/GuiImage';

/** Closed/pending images have no pixels; the control keeps its color fallback. */
export function guiImageSourceReady(source: GuiImageSource): boolean {
  if (!source) return false;
  const image = 'texture' in source ? source.texture : source;
  if ('naturalWidth' in image && 'naturalHeight' in image) return (!('complete' in image) || image.complete) && image.naturalWidth > 0 && image.naturalHeight > 0;
  return 'width' in image && 'height' in image && image.width > 0 && image.height > 0;
}
