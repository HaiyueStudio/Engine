import {validateConstraints} from '../../../layout/validate.js';
import type {RuntimeLayoutDocument} from '../../layout/parameterized/runtime-types.js';
import type {ProductionFontPort, ProductionTextRequest, ProductionTextResult} from './types.js';
import {snapshotTextData, snapshotTextResult, textFail} from './snapshot.js';

/** Owns the prepared platform font port, not another layout solver, input editor or font loader. */
export class ProductionTextOwner {
  private prepared: Awaited<ReturnType<ProductionFontPort['acquire']>> | undefined;
  private pending: Promise<void> | undefined;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal | undefined;
  private readonly abort = () => this.dispose();
  private disposed = false;
  private readonly blocks: ReadonlySet<string>;
  private cache: {key: string; result: ProductionTextResult} | undefined;
  private shapes = 0;
  private releases = 0;
  private releaseFault: unknown;
  private shaping = false;

  constructor(readonly document: RuntimeLayoutDocument, private readonly fonts: ProductionFontPort, options: Readonly<{signal?: AbortSignal}> = {}, private readonly validateStyles?: (styles: NonNullable<ProductionTextRequest['styles']>) => void) {
    if (!fonts || typeof fonts.acquire !== 'function') textFail('E_HYA_RUNTIME_HOST_PORT', '$.host.fonts', 'an explicit prepared font port is required');
    if (options.signal?.aborted) textFail('E_HYA_RUNTIME_ABORTED', '$.signal', 'text creation was cancelled');
    this.blocks = new Set(document.textBlocks.map(block => block.id));
    this.signal = options.signal; this.signal?.addEventListener('abort', this.abort, {once: true});
  }
  prepare(): Promise<void> {
    try {this.assertLive();} catch (error) {return Promise.reject(error);}
    if (this.prepared) return Promise.resolve();
    if (this.pending) return this.pending;
    const job = this.acquire().finally(() => {if (this.pending === job) this.pending = undefined;});
    this.pending = job; return job;
  }
  private async acquire(): Promise<void> {
    const prepared = await this.fonts.acquire(this.document, this.controller.signal);
    if (!prepared || typeof prepared.release !== 'function' || typeof prepared.shape !== 'function') {
      if (prepared && typeof prepared.release === 'function') this.release(prepared);
      textFail('E_HYA_RUNTIME_HOST_PORT', '$.host.fonts.acquire', 'prepared fonts must provide shape and release');
    }
    if (this.disposed) {this.release(prepared); this.assertLive();}
    this.prepared = prepared;
  }
  shape(request: ProductionTextRequest): ProductionTextResult {
    this.assertLive();
    if (!this.prepared) textFail('E_HYA_RUNTIME_HOST_PORT', '$.host.fonts', 'font preparation has not completed');
    if (this.shaping) textFail('E_HYA_RUNTIME_TEXT', '$.text', 'font shaping cannot recursively enter the same owner');
    const input = this.request(request), key = JSON.stringify(input);
    if (this.cache?.key === key) return this.cache.result;
    if (input.styles) this.validateStyles?.(input.styles);
    this.shaping = true;
    try {
      const shaped = this.prepared.shape(input); this.assertLive();
      const result = snapshotTextResult(shaped, input, this.document);
      this.shapes++; this.cache = {key, result}; return result;
    } finally {this.shaping = false;}
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.controller.abort(); this.signal?.removeEventListener('abort', this.abort);
    const prepared = this.prepared; this.prepared = undefined; this.cache = undefined;
    if (prepared) this.release(prepared);
  }
  get stats(): Readonly<{shapes: number; cached: number; pending: boolean; releases: number; releaseFailed: boolean; disposed: boolean}> {
    return Object.freeze({shapes: this.shapes, cached: this.cache ? 1 : 0, pending: !!this.pending, releases: this.releases, releaseFailed: this.releaseFault !== undefined, disposed: this.disposed});
  }
  private request(value: ProductionTextRequest): ProductionTextRequest {
    if (!value || typeof value.block !== 'string' || !this.blocks.has(value.block)) textFail('E_HYA_RUNTIME_TEXT', '$.text.block', 'unknown text block');
    const keys = new Set(['editingViewport','block', 'dpr', 'rasterOrigin', 'strings', 'selections', 'cursors', 'styles', 'constraints']);
    if (Object.keys(value).some(key => !keys.has(key))) textFail('E_HYA_RUNTIME_TEXT', '$.text', 'unknown text request member');
    const request = snapshotTextData(value, '$.text') as unknown as ProductionTextRequest;
    if(request.editingViewport!==undefined&&(typeof request.editingViewport!=='boolean'||request.editingViewport&&!this.document.textBlocks.find(b=>b.id===request.block)?.input))textFail('E_HYA_RUNTIME_TEXT','$.text.editingViewport','unclipped editing requires an editable block and boolean mode');
    if (request.dpr !== undefined && (typeof request.dpr !== 'number' || request.dpr <= 0)) textFail('E_HYA_RUNTIME_TEXT', '$.text.dpr', 'DPR must be finite and positive');
    if (request.rasterOrigin !== undefined && (!Array.isArray(request.rasterOrigin) || request.rasterOrigin.length !== 2 || request.rasterOrigin.some(value => typeof value !== 'number' || !Number.isFinite(value)))) textFail('E_HYA_RUNTIME_TEXT', '$.text.rasterOrigin', 'raster origin must contain two finite logical coordinates');
    for (const name of ['strings', 'selections', 'cursors', 'styles', 'constraints'] as const) {
      const value = request[name];
      if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) textFail('E_HYA_RUNTIME_TEXT', `$.text.${name}`, 'expected a metadata map');
    }
    if (request.constraints) {
      try {validateConstraints({width: request.constraints.width ?? {mode: 'unbounded'}, height: request.constraints.height ?? {mode: 'unbounded'}});}
      catch {textFail('E_HYA_RUNTIME_TEXT', '$.text.constraints', 'invalid finite text measurement constraints');}
    }
    for (const [name, text] of Object.entries(request.strings ?? {})) if (typeof text !== 'string') textFail('E_HYA_RUNTIME_TEXT', `$.text.strings.${name}`, 'text values must be strings');
    for (const [name, selection] of Object.entries(request.selections ?? {})) {
      if (!Array.isArray(selection) || selection.length !== 2 || selection.some(value => !Number.isSafeInteger(value) || value < 0)) textFail('E_HYA_RUNTIME_TEXT', `$.text.selections.${name}`, 'selection offsets must be nonnegative UTF-16 integers');
    }
    for (const [name, cursor] of Object.entries(request.cursors ?? {})) if (!Number.isSafeInteger(cursor) || cursor < 0) textFail('E_HYA_RUNTIME_TEXT', `$.text.cursors.${name}`, 'cursor offset must be a nonnegative UTF-16 integer');
    const styles = new Map(this.document.textStyles.map(style => [style.id, style]));
    for (const [name, patch] of Object.entries(request.styles ?? {})) {
      const original = styles.get(name);
      if (!original || !patch || typeof patch !== 'object' || Array.isArray(patch)) textFail('E_HYA_RUNTIME_TEXT', `$.text.styles.${name}`, 'unknown style or malformed style patch');
      const allowed = new Set(['id', 'fontAssets', 'fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'lineHeight', 'tracking', 'alignment', 'verticalAlignment', 'direction', 'language', 'script', 'axes', 'features', 'fills', 'strokes', 'background']);
      if (Object.keys(patch).some(key => !allowed.has(key)) || patch.id !== undefined && patch.id !== name) textFail('E_HYA_RUNTIME_TEXT', `$.text.styles.${name}`, 'style patch cannot add unknown members or change its stable ID');
      for (const key of ['fontSize', 'lineHeight'] as const) if (patch[key] !== undefined && (typeof patch[key] !== 'number' || patch[key]! <= 0)) textFail('E_HYA_RUNTIME_TEXT', `$.text.styles.${name}.${key}`, 'text metric must be positive');
    }
    return request;
  }
  private release(prepared: {release(): void}): void {
    this.releases++;
    try {prepared.release();} catch (error) {this.releaseFault = error ?? new Error('font release threw an empty value');}
  }
  private assertLive(): void {
    if (this.disposed) textFail(this.signal?.aborted ? 'E_HYA_RUNTIME_ABORTED' : 'E_HYA_RUNTIME_DISPOSED', '$.text', 'text owner is disposed');
  }
}
