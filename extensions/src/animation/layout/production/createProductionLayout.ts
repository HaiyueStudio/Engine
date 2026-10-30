import {ProductionLayoutOwner} from './ProductionLayoutOwner.js';
import type {ProductionTextOwner} from '../../text/production/ProductionTextOwner.js';
import type {RuntimeLayoutDocument} from '../parameterized/runtime-types.js';

/** The layout owns its original evaluator and borrows the caller's prepared text owner. */
export function createProductionLayout(document: RuntimeLayoutDocument,
  options: Readonly<{text?: Pick<ProductionTextOwner, 'shape'>; signal?: AbortSignal}> = {}): Pick<ProductionLayoutOwner, 'evaluate' | 'dispose'> {
  const owner = new ProductionLayoutOwner(document, options.text, options);
  return Object.freeze({evaluate: owner.evaluate.bind(owner), dispose: owner.dispose.bind(owner)});
}
