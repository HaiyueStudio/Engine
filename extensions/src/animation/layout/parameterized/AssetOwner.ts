import type { RuntimeAsset, RuntimeAssetSource, RuntimeLayoutDocument } from './runtime-types.js';

export type LayoutNetworkPolicy = { readonly mode: 'deny' } | { readonly mode: 'same-origin'; readonly baseUrl: string } | { readonly mode: 'allow-list'; readonly baseUrl: string; readonly origins: readonly string[] };
export interface LayoutAssetResolver { resolve(uri: string, signal: AbortSignal): Promise<Uint8Array | ArrayBuffer>; }
export interface LayoutAssetMaterialized { destroy(): void; }
export interface LayoutAssetMaterializer { materialize(asset: RuntimeAsset, bytes: Uint8Array, device: GPUDevice | undefined, signal: AbortSignal): Promise<LayoutAssetMaterialized>; }
export interface LayoutAssetHandle { readonly id: string; readonly generation: number; readonly bytes: Uint8Array; readonly materialized?: LayoutAssetMaterialized | undefined; release(): void; }
export interface LayoutAssetOwnerOptions { readonly resolver?: LayoutAssetResolver; readonly policy: LayoutNetworkPolicy; readonly materializer?: LayoutAssetMaterializer; readonly maxAssetBytes?: number; readonly maxTotalBytes?: number; readonly device?: GPUDevice; }
export class LayoutAssetError extends Error { readonly name = 'LayoutAssetError'; constructor(readonly code: 'E_LAYOUT_ASSET_REFERENCE' | 'E_LAYOUT_ASSET_NETWORK' | 'E_LAYOUT_ASSET_INTEGRITY' | 'E_LAYOUT_ASSET_LIMIT' | 'E_LAYOUT_ASSET_ABORTED' | 'E_LAYOUT_ASSET_DISPOSED', message: string) { super(message); } }
interface Entry { readonly id: string; readonly generation: number; refs: number; readonly controller: AbortController; promise: Promise<Resolved>; resolved?: Resolved; retired: boolean; }
interface Resolved { readonly bytes: Uint8Array; materialized?: LayoutAssetMaterialized; }

export class LayoutAssetOwner<T extends Pick<RuntimeLayoutDocument, 'assets'> = RuntimeLayoutDocument> {
  private readonly assets: Map<string, RuntimeAsset>;
  private readonly entries = new Map<string, Entry>();
  /** A replaced generation can still be held by a committed frame. */
  private readonly retained = new Set<Entry>();
  private readonly cache = new Map<string, Uint8Array>();
  private readonly hosted = new Map<string, RuntimeAssetSource>();
  private readonly overrides = new Map<string, RuntimeAssetSource>();
  private disposed = false;
  private lost = false;
  private generation = 0;
  private deviceEpoch = 0;
  private device: GPUDevice | undefined;
  private totalBytes = 0;
  private readonly maxAssetBytes: number;
  private readonly maxTotalBytes: number;
  constructor(readonly document: T, private readonly options: LayoutAssetOwnerOptions) {
    this.maxAssetBytes = options.maxAssetBytes ?? 256 * 1024 * 1024; this.maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024 * 1024;
    if (![this.maxAssetBytes, this.maxTotalBytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw new LayoutAssetError('E_LAYOUT_ASSET_LIMIT', 'Asset byte ceilings must be finite non-negative integers.');
    this.options = Object.freeze({...options, policy: Object.freeze({...options.policy, ...(options.policy.mode === 'allow-list' ? {origins: Object.freeze([...options.policy.origins])} : {})})});
    this.assets = new Map(document.assets.map(asset => [asset.id, Object.freeze({...asset, ...(asset.kind === 'folder' ? {children: Object.freeze([...asset.children])} : {source: this.snapshotSource(asset.source, false)})}) as RuntimeAsset]));
    this.device = options.device;
  }

  setHostedReplacement(slot: string, source: RuntimeAssetSource): void {
    this.assertLive(); if (typeof slot !== 'string' || !slot) throw new LayoutAssetError('E_LAYOUT_ASSET_REFERENCE', 'Hosted slot must be non-empty.');
    const replacement = this.snapshotSource(source);
    const affected = this.affected(undefined, slot); this.hosted.set(slot, replacement); for (const id of affected) this.retire(id);
  }
  replace(id: string, source: RuntimeAssetSource): void {
    this.assertLive(); const asset = this.assets.get(id); if (!asset || asset.kind === 'folder') throw new LayoutAssetError('E_LAYOUT_ASSET_REFERENCE', `Unknown loadable asset ${id}.`);
    const replacement = this.snapshotSource(source), affected = this.affected(id);
    this.overrides.set(id, replacement); for (const key of affected) this.retire(key);
  }
  async load(id: string, options: Readonly<{signal?: AbortSignal}> = {}): Promise<LayoutAssetHandle> {
    this.assertLive(); const asset = this.assets.get(id); if (!asset || asset.kind === 'folder') throw new LayoutAssetError('E_LAYOUT_ASSET_REFERENCE', `Asset ${id} is not loadable.`);
    const signal = options.signal;
    if (signal?.aborted) throw new LayoutAssetError('E_LAYOUT_ASSET_ABORTED', `Asset ${id} acquisition was cancelled.`);
    let entry = this.entries.get(id);
    if (!entry) {
      if (!Number.isSafeInteger(this.generation + 1)) throw new LayoutAssetError('E_LAYOUT_ASSET_LIMIT', 'Asset generation exhausted.');
      entry = {id, generation: ++this.generation, refs: 0, controller: new AbortController(), promise: undefined!, retired: false};
      this.entries.set(id, entry); this.retained.add(entry); entry.promise = this.prepare(entry, asset);
    }
    const selected = entry; selected.refs++;
    let released = false;
    const release = (): void => {if (released) return; released = true; this.release(selected);};
    let waiting = selected.promise, removeAbort = (): void => {};
    if (signal) {
      const cancellation = new Promise<never>((_resolve, reject) => {
        const abort = (): void => {
          const error = new LayoutAssetError('E_LAYOUT_ASSET_ABORTED', `Asset ${id} acquisition was cancelled.`);
          try {release(); reject(error);} catch (cleanup) {reject(new AggregateError([error, cleanup], 'Cancelled asset acquisition cleanup failed.'));}
        };
        signal.addEventListener('abort', abort, {once: true}); removeAbort = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
      });
      waiting = Promise.race([waiting, cancellation]);
    }
    try {
      const resolved = await waiting;
      if (signal?.aborted) throw new LayoutAssetError('E_LAYOUT_ASSET_ABORTED', `Asset ${id} acquisition was cancelled.`);
      this.assertEntry(selected);
      return Object.freeze({id, generation: selected.generation, bytes: new Uint8Array(resolved.bytes),
        // A stable handle follows its own generation across device recovery.
        get materialized() {return released ? undefined : resolved.materialized;},
        release});
    } catch (error) {release(); throw error;} finally {removeAbort();}
  }

  notifyDeviceLost(): void {
    if (this.disposed) return; this.lost = true; this.deviceEpoch++;
    const errors: unknown[] = []; for (const entry of this.retained) {try {this.destroyMaterialized(entry.resolved);} catch (error) {errors.push(error);}}
    if (errors.length) throw new AggregateError(errors, 'Asset device-loss cleanup failed.');
  }
  async recoverDevice(device: GPUDevice): Promise<void> {
    this.assertLive(); this.notifyDeviceLost(); this.device = device; const epoch = this.deviceEpoch;
    const materializer = this.options.materializer; if (!materializer) {this.lost = false; return;}
    const rebuilt = new Map<Entry, LayoutAssetMaterialized>();
    const active = (): void => {if (this.disposed || this.deviceEpoch !== epoch) throw new LayoutAssetError('E_LAYOUT_ASSET_ABORTED', 'Device recovery was superseded.');};
    try {
      // Resolved entries added while awaiting a host also participate in this recovery.
      while (true) {
        active(); const next = [...this.retained].find(entry => entry.refs > 0 && entry.resolved && !rebuilt.has(entry)); if (!next) break;
        const handle = await materializer.materialize(this.assets.get(next.id)!, new Uint8Array(next.resolved!.bytes), device, next.controller.signal);
        if (this.disposed || this.deviceEpoch !== epoch) {handle.destroy(); active();}
        if (!this.retained.has(next) || next.refs <= 0) {handle.destroy(); continue;}
        rebuilt.set(next, handle);
      }
      // Finish borrowed cleanup callbacks before the infallible logical publication.
      while (true) {
        const dropped = [...rebuilt.keys()].find(entry => !this.retained.has(entry) || entry.refs <= 0); if (!dropped) break;
        const handle = rebuilt.get(dropped)!; rebuilt.delete(dropped); handle.destroy();
      }
      active(); for (const [entry, handle] of rebuilt) entry.resolved!.materialized = handle;
      rebuilt.clear();
      this.lost = false;
    } catch (error) {
      const errors = [error]; for (const handle of rebuilt.values()) {try {handle.destroy();} catch (failure) {errors.push(failure);}}
      throw errors.length === 1 ? error : new AggregateError(errors, 'Asset recovery and staged cleanup failed.');
    }
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.deviceEpoch++;
    const errors: unknown[] = []; for (const entry of [...this.retained]) {try {this.destroyEntry(entry);} catch (error) {errors.push(error);}}
    this.entries.clear(); this.cache.clear(); this.hosted.clear(); this.overrides.clear(); this.totalBytes = 0;
    if (errors.length) throw new AggregateError(errors, 'Asset disposal failed.');
  }
  get stats(): Readonly<{ entries: number; references: number; cacheEntries: number; totalBytes: number; generation: number; lost: boolean; disposed: boolean }> { return Object.freeze({ entries: this.retained.size, references: [...this.retained].reduce((sum, entry) => sum + entry.refs, 0), cacheEntries: this.cache.size, totalBytes: this.totalBytes, generation: this.generation, lost: this.lost, disposed: this.disposed }); }

  private async prepare(entry: Entry, asset: Exclude<RuntimeAsset, {kind: 'folder'}>): Promise<Resolved> {
    const bytes = await this.resolve(asset, this.overrides.get(asset.id) ?? asset.source, entry.controller.signal, new Set([asset.id])); this.assertEntry(entry);
    const resolved: Resolved = {bytes};
    if (this.options.materializer && !this.lost) {
      const epoch = this.deviceEpoch, handle = await this.options.materializer.materialize(asset, new Uint8Array(bytes), this.device, entry.controller.signal);
      if (entry.controller.signal.aborted || this.disposed || !this.retained.has(entry) || this.lost || epoch !== this.deviceEpoch) {
        handle.destroy(); throw new LayoutAssetError('E_LAYOUT_ASSET_ABORTED', `Late materialization for ${asset.id} was retired.`);
      }
      resolved.materialized = handle;
    }
    this.assertEntry(entry); entry.resolved = resolved; return resolved;
  }

  private async resolve(asset: RuntimeAsset, source: RuntimeAssetSource, signal: AbortSignal, stack: Set<string>): Promise<Uint8Array> { if (signal.aborted) throw new LayoutAssetError('E_LAYOUT_ASSET_ABORTED', `Asset ${asset.id} was aborted.`); if (source.kind === 'hosted') { const slotKey = `@slot:${source.slot}`; if (stack.has(slotKey)) throw new LayoutAssetError('E_LAYOUT_ASSET_REFERENCE', 'Hosted replacement cycle.'); stack.add(slotKey); const replacement = this.hosted.get(source.slot); if (replacement) return this.resolve(asset, replacement, signal, stack); if (source.fallbackAsset) { if (stack.has(source.fallbackAsset)) throw new LayoutAssetError('E_LAYOUT_ASSET_REFERENCE', 'Hosted fallback cycle.'); const fallback = this.assets.get(source.fallbackAsset); if (!fallback || fallback.kind === 'folder') throw new LayoutAssetError('E_LAYOUT_ASSET_REFERENCE', `Missing fallback ${source.fallbackAsset}.`); stack.add(fallback.id); return this.resolve(fallback, this.overrides.get(fallback.id) ?? fallback.source, signal, stack); } throw new LayoutAssetError('E_LAYOUT_ASSET_REFERENCE', `Hosted slot ${source.slot} has no replacement.`); }
    const effective = source, expected = effective.integrity, key = integrityKey(expected); if (effective.kind === 'referenced') this.checkNetwork(effective.uri); const cached = this.cache.get(key); if (cached) return cached;
    let bytes: Uint8Array; if (effective.kind === 'embedded') bytes = Uint8Array.from(effective.data); else { this.checkNetwork(effective.uri); if (!this.options.resolver) throw new LayoutAssetError('E_LAYOUT_ASSET_NETWORK', 'No resolver was supplied.'); try { const result = await this.options.resolver.resolve(effective.uri, signal); bytes = result instanceof Uint8Array ? new Uint8Array(result) : new Uint8Array(result.slice(0)); } catch (error) { if (signal.aborted) throw new LayoutAssetError('E_LAYOUT_ASSET_ABORTED', `Asset ${asset.id} was aborted.`); throw new LayoutAssetError('E_LAYOUT_ASSET_NETWORK', error instanceof Error ? error.message : String(error)); } }
    if (signal.aborted) throw new LayoutAssetError('E_LAYOUT_ASSET_ABORTED', `Asset ${asset.id} was aborted.`);
    if (bytes.byteLength > this.maxAssetBytes) throw new LayoutAssetError('E_LAYOUT_ASSET_LIMIT', `Asset ${asset.id} exceeds byte budget.`);
    const digest = await sha256(bytes), actual = `sha256-${base64(digest)}`;
    if (actual !== key) throw new LayoutAssetError('E_LAYOUT_ASSET_INTEGRITY', `Asset ${asset.id} expected ${expected}, received ${actual}.`);
    if (signal.aborted || this.disposed) throw new LayoutAssetError('E_LAYOUT_ASSET_ABORTED', `Asset ${asset.id} was aborted.`);
    // Hashing yields: another asset may have populated the same content or used the remaining bytes.
    const existing = this.cache.get(key); if (existing) return existing;
    if (this.totalBytes + bytes.byteLength > this.maxTotalBytes) throw new LayoutAssetError('E_LAYOUT_ASSET_LIMIT', `Asset ${asset.id} exceeds total byte budget.`);
    const stable = new Uint8Array(bytes); this.cache.set(key, stable); this.totalBytes += stable.byteLength; return stable; }
  private checkNetwork(uri: string): void { if (this.options.policy.mode === 'deny') throw new LayoutAssetError('E_LAYOUT_ASSET_NETWORK', 'Network access is denied by host policy.'); let resolved: URL; try { resolved = new URL(uri, this.options.policy.baseUrl); } catch { throw new LayoutAssetError('E_LAYOUT_ASSET_NETWORK', `Invalid asset URL ${uri}.`); } const base = new URL(this.options.policy.baseUrl); if (this.options.policy.mode === 'same-origin' && resolved.origin !== base.origin) throw new LayoutAssetError('E_LAYOUT_ASSET_NETWORK', `Cross-origin asset ${resolved.origin} is denied.`); if (this.options.policy.mode === 'allow-list' && resolved.origin !== base.origin && !this.options.policy.origins.includes(resolved.origin)) throw new LayoutAssetError('E_LAYOUT_ASSET_NETWORK', `Origin ${resolved.origin} is not allowed.`); }
  private release(entry: Entry): void {if (!this.retained.has(entry)) return; entry.refs--; if (entry.refs <= 0) this.destroyEntry(entry);}
  private retire(id: string): void {
    const entry = this.entries.get(id); if (!entry) return; this.entries.delete(id); entry.retired = true;
    // There is no committed handle for a pending generation. Its late host work must unwind.
    if (!entry.resolved) entry.controller.abort();
    if (entry.refs <= 0) this.destroyEntry(entry);
  }
  private destroyEntry(entry: Entry): void {
    if (!this.retained.delete(entry)) return;
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    entry.retired = true; entry.controller.abort(); this.destroyMaterialized(entry.resolved);
  }
  private destroyMaterialized(resolved: Resolved | undefined): void {
    const value = resolved?.materialized; if (!value) return; delete resolved!.materialized; value.destroy();
  }
  private assertEntry(entry: Entry): void {
    if (entry.controller.signal.aborted || this.disposed || !this.retained.has(entry)) throw new LayoutAssetError('E_LAYOUT_ASSET_ABORTED', `Late asset ${entry.id} result was retired.`);
  }
  private affected(assetId?: string, slot?: string): readonly string[] {
    const depends = (id: string, seen: Set<string>): boolean => {
      if (id === assetId) return true; if (seen.has(id)) return false; seen.add(id);
      const asset = this.assets.get(id); if (!asset || asset.kind === 'folder') return false;
      const source = this.overrides.get(id) ?? asset.source;
      const visit = (value: RuntimeAssetSource, slots: Set<string>): boolean => {
        if (value.kind !== 'hosted') return false; if (value.slot === slot) return true;
        if (slots.has(value.slot)) return false; slots.add(value.slot);
        const replacement = this.hosted.get(value.slot);
        return replacement ? visit(replacement, slots) : !!value.fallbackAsset && depends(value.fallbackAsset, seen);
      };
      return visit(source, new Set());
    };
    return [...this.entries.keys()].filter(id => depends(id, new Set()));
  }
  private snapshotSource(source: RuntimeAssetSource, enforceLimit = true): RuntimeAssetSource {
    if (!source || typeof source !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(source))) throw new LayoutAssetError('E_LAYOUT_ASSET_REFERENCE', 'Asset source must be plain data.');
    const descriptors = Object.getOwnPropertyDescriptors(source);
    if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || !descriptors[key]?.enumerable || !('value' in descriptors[key]!))) throw new LayoutAssetError('E_LAYOUT_ASSET_REFERENCE', 'Asset source cannot contain accessors or hidden members.');
    const kind = source.kind, keys = kind === 'embedded' ? ['kind', 'data', 'integrity'] : kind === 'referenced' ? ['kind', 'uri', 'integrity'] : kind === 'hosted' ? ['kind', 'slot', 'fallbackAsset', 'integrity'] : [];
    if (!keys.length || Object.keys(source).some(key => !keys.includes(key))) throw new LayoutAssetError('E_LAYOUT_ASSET_REFERENCE', 'Unknown asset source fields.');
    if (kind === 'hosted') {
      if (!source.slot || typeof source.slot !== 'string' || source.fallbackAsset !== undefined && (typeof source.fallbackAsset !== 'string' || !source.fallbackAsset)) throw new LayoutAssetError('E_LAYOUT_ASSET_REFERENCE', 'Hosted source requires stable slot and fallback IDs.');
      if (source.integrity !== undefined) integrityKey(source.integrity);
      return Object.freeze({...source});
    }
    integrityKey(source.integrity);
    if (kind === 'referenced') {if (typeof source.uri !== 'string' || !source.uri) throw new LayoutAssetError('E_LAYOUT_ASSET_NETWORK', 'Referenced source requires a URI.'); return Object.freeze({...source});}
    const data = source.data;
    const length = data && ArrayBuffer.isView(data) && !(data instanceof DataView)
      ? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length')!.get!.call(data) as number
      : data && Object.getOwnPropertyDescriptor(data, 'length')?.value as number | undefined;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || enforceLimit && length > this.maxAssetBytes) throw new LayoutAssetError('E_LAYOUT_ASSET_LIMIT', 'Embedded asset exceeds byte budget or has an invalid length.');
    const copy = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(data, String(index)), value = descriptor && 'value' in descriptor ? descriptor.value as unknown : undefined;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) throw new LayoutAssetError('E_LAYOUT_ASSET_REFERENCE', 'Embedded asset must contain byte values without getters.');
      copy[index] = value;
    }
    return Object.freeze({kind, data: copy, integrity: source.integrity});
  }
  private assertLive(): void { if (this.disposed) throw new LayoutAssetError('E_LAYOUT_ASSET_DISPOSED', 'Asset owner is disposed.'); }
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)); }
function base64(bytes: Uint8Array): string { const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', output: string[] = []; for (let index = 0; index < bytes.length; index += 3) { const a = bytes[index]!, b = bytes[index + 1], c = bytes[index + 2], value = a << 16 | (b ?? 0) << 8 | (c ?? 0); output.push(table[value >>> 18 & 63]!, table[value >>> 12 & 63]!, b === undefined ? '=' : table[value >>> 6 & 63]!, c === undefined ? '=' : table[value & 63]!); } return output.join(''); }
function integrityKey(value: string): string {
  if (typeof value === 'string' && /^sha256-[0-9a-fA-F]{64}$/u.test(value)) return 'sha256-' + base64(Uint8Array.from(value.slice(7).match(/../gu)!, byte => parseInt(byte, 16)));
  if (typeof value !== 'string' || !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(value)) throw new LayoutAssetError('E_LAYOUT_ASSET_INTEGRITY', 'Asset integrity must be SHA-256.');
  return value;
}

export {integrityKey as normalizeLayoutAssetIntegrity};
