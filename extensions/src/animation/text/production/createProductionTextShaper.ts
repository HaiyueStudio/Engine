import {ProductionTextOwner} from './ProductionTextOwner.js';
import type {ProductionFontPort} from './types.js';
import type {RuntimeLayoutDocument} from '../../layout/parameterized/runtime-types.js';

/** A prepared, owned font lease behind the focused public text facade. */
export async function createProductionTextShaper(document: RuntimeLayoutDocument, fonts: ProductionFontPort,
  options: Readonly<{signal?: AbortSignal}> = {}): Promise<Pick<ProductionTextOwner, 'shape' | 'dispose'>> {
  const owner = new ProductionTextOwner(document, fonts, options);
  try {
    await owner.prepare();
    return Object.freeze({shape: owner.shape.bind(owner), dispose: owner.dispose.bind(owner)});
  } catch (error) {
    owner.dispose();
    throw error;
  }
}
