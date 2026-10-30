import {snapshotNativeGlyphBitmap,nativeGlyphBitmapIdentity} from '../../text/production/NativeGlyphBitmap.js';
import type {AssetHandle} from '@haiyue/engine/assets';
import type {IEngine} from '@haiyue/engine/extension-authoring';
import type {LayoutAssetOwner} from '../parameterized/AssetOwner.js';
import type {RuntimeAssetSource} from '../parameterized/runtime-types.js';
import type {ProductionGlyph} from '../../text/production/types.js';
import {ProductionDrawError, type ProductionDrawTexture, type ProductionDrawTextures} from './ProductionDrawPlan.js';
import type {ProductionLayoutFrame, ProductionLayoutNode} from './types.js';

type BitmapSource = Extract<ProductionGlyph['paint'], {kind: 'bitmap'}>['source'];
type DecodedImage = Readonly<{value: ImageBitmap; release(): void}>;
export interface ProductionEncodedImage {readonly value: Uint8Array; readonly generation: number; readonly bytes: number; readonly width?: number; readonly height?: number;}
interface Request {readonly inferredSize?: boolean; readonly key: string; readonly bytes: number; readonly part?: string; readonly sampling?: ProductionDrawTexture['sampling']; decode(signal: AbortSignal): Promise<DecodedImage>;}
interface Entry {
  readonly request: Pick<Request, 'key' | 'inferredSize' | 'part' | 'sampling'> & {bytes: number}; readonly controller: AbortController; readonly ready: Promise<void>;
  decode?: Request['decode'];
  resolve(): void; reject(error: unknown): void;
  state: 'queued' | 'loading' | 'ready' | 'failed'; refs: number; retired: boolean; removed: boolean;
  handle?: AssetHandle<GPUTexture>; image?: DecodedImage; error?: unknown;
}
export interface ProductionTextureHost {
  decode(bytes: Uint8Array, signal: AbortSignal): Promise<DecodedImage>;
  snapshot(source: unknown, signal: AbortSignal): Promise<DecodedImage>;
}
export interface ProductionTextureOptions {
  /** Explicit host ceilings, not newly established global production budgets. */
  readonly maxTextureBytes: number; readonly maxBitmapBytes: number; readonly maxEntries: number; readonly maxConcurrent: number;
  readonly alphaMode?: ProductionDrawTexture['alphaMode'];
  readonly host?: ProductionTextureHost; readonly invalidate?: (reason: string) => void; readonly diagnostic?: (error: unknown) => void;
}
export class ProductionTexturePending extends ProductionDrawError {
  constructor(readonly ready: Promise<void>) {super('E_HYA_RUNTIME_RESOURCE_PENDING', '$.draw.textures', 'prepared texture resources are pending'); void ready.catch(() => {});}
}
function fail(code: string, message: string): never {throw new ProductionDrawError(code, '$.draw.textures', message);}
let nextOwner = 0;

/** Owns ready-texture leases over the original SHA loader and Engine upload/recovery cache. */
export class ProductionTextureOwner implements ProductionDrawTextures {
  private readonly current = new Map<string, Entry>();
  private readonly retained = new Set<Entry>();
  private readonly queue: Entry[] = [];
  private pendingWait:Readonly<{entries:readonly Entry[];ready:Promise<void>}>|undefined;
  private readonly bitmapIds = new WeakMap<object, number>();
  private readonly assets: Map<string, LayoutAssetOwner>;
  private readonly imageMetadata: Map<string, ReadonlyMap<string, Readonly<{width: number; height: number; filter?: string; wrapX?: string; wrapY?: string}>>>;
  private readonly host: ProductionTextureHost;
  private readonly unregister: (() => void) | undefined;
  private readonly failures: unknown[] = [];
  private bytes = 0; private active = 0; private serial = 0; private version = 0;
  private acquired = 0; private released = 0; private disposed = false; private lost = false; private preparing = false;
  readonly recoveryLabel = `HYA prepared textures:${++nextOwner}`;
  readonly recoverySource = {kind: 'hya-layout-textures' as const};
  constructor(private readonly engine: IEngine, assets: ReadonlyMap<string, LayoutAssetOwner>, private readonly options: ProductionTextureOptions) {
    for (const [name, value] of Object.entries({maxTextureBytes: options.maxTextureBytes, maxBitmapBytes: options.maxBitmapBytes, maxEntries: options.maxEntries, maxConcurrent: options.maxConcurrent}))
      if (!Number.isSafeInteger(value) || value < (name === 'maxConcurrent' ? 1 : 0)) fail('E_HYA_RUNTIME_LIMIT', `invalid texture host ceiling ${name}`);
    if (options.alphaMode !== undefined && !['straight', 'premultiplied'].includes(options.alphaMode)) fail('E_HYA_RUNTIME_HOST_PORT', 'invalid texture alpha mode');
    if (!engine.assetManager) fail('E_HYA_RUNTIME_HOST_PORT', 'an initialized public Engine AssetManager is required');
    this.assets = new Map(assets); this.options = Object.freeze({...options});
    this.imageMetadata = new Map([...assets].map(([part, owner]) => [part, new Map(owner.document.assets.filter(asset => asset.kind === 'image').map(asset => {
      const value = asset as typeof asset & {filter?: string; wrapX?: string; wrapY?: string};
      return [asset.id, Object.freeze({width: value.width, height: value.height, ...(value.filter ? {filter: value.filter} : {}), ...(value.wrapX ? {wrapX: value.wrapX} : {}), ...(value.wrapY ? {wrapY: value.wrapY} : {})})];
    }))]));
    const host = options.host ?? browserTextureHost();
    if (typeof host.decode !== 'function' || typeof host.snapshot !== 'function') fail('E_HYA_RUNTIME_HOST_PORT', 'image host requires decode and snapshot');
    this.host = Object.freeze({decode: host.decode.bind(host), snapshot: host.snapshot.bind(host)});
    this.unregister = engine.registerDeviceRecoveryParticipant?.(this);
  }
  get revision(): number {return this.version;}
  /** Starts all resources for the latest requested frame before the synchronous draw transaction commits. */
  prepare(frames: readonly ProductionLayoutFrame[]): void {
    this.live(); if (this.preparing) fail('E_HYA_RUNTIME_REENTRANT', 'texture preparation cannot reenter'); this.preparing = true;
    try {
      const requests = new Map<string, Request>();
      const request = (value: Request): void => {if (!requests.has(value.key) && requests.size >= this.options.maxEntries) fail('E_HYA_RUNTIME_LIMIT', 'frame texture requests exceed explicit entry ceiling'); requests.set(value.key, value);};
      for (const frame of frames) for (const node of frame.nodes) {
        if (!node.opacity || !node.rect[2] || !node.rect[3]) continue;
        if (node.source) request(this.imageRequest(node));
        for (const run of node.text?.runs ?? []) for (const glyph of run.glyphs) if (glyph.paint.kind === 'bitmap') {
          request(this.bitmapRequest(glyph.paint.source));
        }
      }
      // Old draw plans own independent leases, so only unleased unused resources can disappear here.
      for (const entry of [...this.current.values()]) if (!requests.has(entry.request.key)) this.retire(entry);
      const entries: Entry[] = [];
      try {for (const request of requests.values()) entries.push(this.ensure(request));}
      catch (error) {for (const entry of entries) if (!entry.refs) this.retire(entry); throw error;}
      const failed = entries.find(entry => entry.state === 'failed'); if (failed) throw failed.error;
      const pending = entries.filter(entry => entry.state !== 'ready');
      if (pending.length) {
        let wait=this.pendingWait;
        if(!wait||wait.entries.length!==pending.length||pending.some((entry,index)=>entry!==wait!.entries[index])){
          const ready=Promise.all(pending.map(entry=>entry.ready)).then(()=>{});wait=Object.freeze({entries:Object.freeze([...pending]),ready});this.pendingWait=wait;
          void ready.finally(()=>{if(this.pendingWait===wait)this.pendingWait=undefined;}).catch(()=>{});
        }
        throw new ProductionTexturePending(wait.ready);
      }
    } finally {this.preparing = false;}
  }
  image(node: ProductionLayoutNode): ProductionDrawTexture {return this.acquire(this.ensure(this.imageRequest(node)));}
  encodedImage(source: ProductionEncodedImage): ProductionDrawTexture {return this.acquire(this.ensure(this.encodedRequest(source)));}
  bitmap(source: BitmapSource): ProductionDrawTexture {return this.acquire(this.ensure(this.bitmapRequest(source)));}
  replaceImage(part: string, id: string, source: RuntimeAssetSource): void {
    this.live(); this.assetOwner(part).replace(id, source); this.retirePart(part); this.changed('image-replaced');
  }
  setHostedReplacement(part: string, slot: string, source: RuntimeAssetSource): void {
    this.live(); this.assetOwner(part).setHostedReplacement(slot, source); this.retirePart(part); this.changed('hosted-image-replaced');
  }
  retryFailed(): void {
    this.live(); for (const entry of [...this.current.values()]) if (entry.state === 'failed') this.retire(entry); this.changed('texture-retry');
  }
  async whenIdle(): Promise<void> {
    while (this.active || this.queue.length) await Promise.all([...this.retained].filter(entry => entry.state === 'queued' || entry.state === 'loading').map(entry => entry.ready.catch(() => {})));
  }
  /** Disposal never destroys an acquired draw lease; the draw owner releases it after its queue fence. */
  dispose(): void {if (this.disposed) return; this.disposed = true; this.pendingWait=undefined; try {this.unregister?.();} catch (error) {this.report(error);} for (const entry of [...this.current.values()]) this.retire(entry); this.assets.clear(); this.imageMetadata.clear();}
  suspendForDeviceLoss(): void {
    if (this.disposed || this.lost) return; this.lost = true;
    for (const entry of [...this.current.values()]) if (entry.state !== 'ready') this.retire(entry);
    this.version++;
  }
  recoverGpuResource(device: GPUDevice, signal: AbortSignal): void {
    this.live(false); if (signal.aborted) throw signal.reason;
    if (device !== this.engine.device) fail('E_HYA_RUNTIME_HOST_PORT', 'texture recovery requires the active Engine device');
    // Engine recovers AssetManager before registered scene participants. Stable acquired handles follow that recovery.
    for (const entry of this.retained) if (entry.state === 'ready' && !entry.removed) void entry.handle!.value;
    this.lost = false; this.changed('textures-recovered');
  }
  private assetOwner(part: string): LayoutAssetOwner {return this.assets.get(part) ?? fail('E_HYA_RUNTIME_HOST_PORT', `no asset owner for layout part ${part}`);}
  private imageRequest(node: ProductionLayoutNode): Request {
    this.live(); const source = node.source;
    if (!source || source.kind !== 'asset') fail('E_HYA_RUNTIME_HOST_PORT', 'source-node capture still requires the composed capture owner');
    const assets = this.assetOwner(node.part), asset = this.imageMetadata.get(node.part)?.get(source.id);
    if (!asset) fail('E_HYA_RUNTIME_HOST_PORT', `asset ${source.id} is not an image`);
    const filter = asset.filter ?? 'linear', wrapX = asset.wrapX ?? 'clamp', wrapY = asset.wrapY ?? 'clamp';
    if (!['nearest', 'linear'].includes(filter) || !['clamp', 'repeat', 'mirror'].includes(wrapX) || !['clamp', 'repeat', 'mirror'].includes(wrapY)) fail('E_HYA_RUNTIME_HOST_PORT', 'invalid authored image sampling');
    const sampling = Object.freeze({filter, wrapX, wrapY}) as NonNullable<ProductionDrawTexture['sampling']>;
    const bytes = rgbaBytes(asset.width, asset.height);
    return {key: JSON.stringify(['image', node.part, source.id]), part: node.part, bytes, sampling, decode: async signal => {
      const handle = await assets.load(source.id, {signal});
      try {aborted(signal); return await this.host.decode(handle.bytes, signal);} finally {handle.release();}
    }};
  }
  private bitmapRequest(source: BitmapSource): Request {
    this.live(); const value = source.value;
    if (!value || typeof value !== 'object' || !Number.isSafeInteger(source.generation) || source.generation < 0) fail('E_HYA_RUNTIME_HOST_PORT', 'bitmap source requires an object and stable generation');
    const size = value as {width?: number; height?: number}, bytes = rgbaBytes(size.width, size.height);
    if (!Number.isSafeInteger(source.bytes) || source.bytes < bytes) fail('E_HYA_RUNTIME_LIMIT', 'bitmap byte metadata must include its RGBA pixels');
    const native = nativeGlyphBitmapIdentity(value);
    if (native) {
      let id = this.bitmapIds.get(native.owner);
      if (id === undefined) {id = ++this.serial; if (!Number.isSafeInteger(id)) fail('E_HYA_RUNTIME_LIMIT', 'bitmap identity exhausted'); this.bitmapIds.set(native.owner, id);}
      return {key: JSON.stringify(['native-glyph', id, native.key, size.width, size.height]), bytes, decode: signal => snapshotNativeGlyphBitmap(value, signal, this.host.snapshot)};
    }
    let id = this.bitmapIds.get(value); if (id === undefined) {id = ++this.serial; if (!Number.isSafeInteger(id)) fail('E_HYA_RUNTIME_LIMIT', 'bitmap identity exhausted'); this.bitmapIds.set(value, id);}
    return {key: JSON.stringify(['bitmap', id, source.generation]), bytes, decode: signal => snapshotNativeGlyphBitmap(value, signal, this.host.snapshot)};
  }
  private encodedRequest(source: ProductionEncodedImage): Request {
    this.live();
    if (!(source.value instanceof Uint8Array) || !Number.isSafeInteger(source.generation) || source.generation < 0
      || !Number.isSafeInteger(source.bytes) || source.bytes !== source.value.byteLength) fail('E_HYA_RUNTIME_HOST_PORT', 'encoded source needs stable owned bytes and generation');
    for (const size of [source.width, source.height]) if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0)) fail('E_HYA_RUNTIME_HOST_PORT', 'declared encoded image dimensions must be positive safe integers');
    const inferredSize = source.width === undefined || source.height === undefined;
    const bytes = inferredSize ? 0 : rgbaBytes(source.width, source.height);
    let id = this.bitmapIds.get(source.value); if (id === undefined) {id = ++this.serial; if (!Number.isSafeInteger(id)) fail('E_HYA_RUNTIME_LIMIT', 'encoded identity exhausted'); this.bitmapIds.set(source.value, id);}
    return {key: JSON.stringify(['encoded', id, source.generation]), bytes, inferredSize, decode: async signal => {
      const image = await this.host.decode(source.value, signal);
      if (image && typeof image.release === 'function' && (source.width !== undefined && image.value?.width !== source.width || source.height !== undefined && image.value?.height !== source.height)) {
        image.release(); fail('E_HYA_RUNTIME_HOST_PORT', 'decoded image dimensions do not match declared core metadata');
      }
      return image;
    }};
  }
  private ensure(request: Request): Entry {
    this.live(); let entry = this.current.get(request.key); if (entry) return entry;
    if (this.retained.size >= this.options.maxEntries || this.bytes + request.bytes > Math.min(this.options.maxTextureBytes, this.options.maxBitmapBytes))
      fail('E_HYA_RUNTIME_LIMIT', 'prepared and retained textures exceed explicit host ceilings');
    let resolve!: () => void, reject!: (error: unknown) => void;
    const ready = new Promise<void>((yes, no) => {resolve = yes; reject = no;}); void ready.catch(() => {});
    entry = {request: {key: request.key, bytes: request.bytes, ...(request.inferredSize ? {inferredSize: true} : {}), ...(request.part === undefined ? {} : {part: request.part}), ...(request.sampling ? {sampling: request.sampling} : {})}, decode: request.decode, controller: new AbortController(), ready, resolve, reject, state: 'queued', refs: 0, retired: false, removed: false};
    this.current.set(request.key, entry); this.retained.add(entry); this.bytes += request.bytes; this.version++;
    this.queue.push(entry); this.pump(); return entry;
  }
  private pump(): void {
    while (!this.disposed && !this.lost && this.active < this.options.maxConcurrent && this.queue.length) {
      const entry = this.queue.shift()!; if (entry.retired) continue;
      this.active++; entry.state = 'loading'; void this.load(entry);
    }
  }
  private async load(entry: Entry): Promise<void> {
    let image: DecodedImage | undefined, handle: AssetHandle<GPUTexture> | undefined;
    try {
      const decode = entry.decode!; delete entry.decode;
      image = await decode(entry.controller.signal); aborted(entry.controller.signal);
      if (!image || typeof image.release !== 'function') fail('E_HYA_RUNTIME_HOST_PORT', 'decoded image needs an acquired release lease');
      const decodedBytes = rgbaBytes(image.value?.width, image.value?.height);
      if (entry.request.inferredSize) {
        if (this.bytes + decodedBytes > Math.min(this.options.maxTextureBytes, this.options.maxBitmapBytes)) fail('E_HYA_RUNTIME_LIMIT', 'decoded core image exceeds explicit retained texture/bitmap ceilings');
        entry.request.bytes = decodedBytes; this.bytes += decodedBytes;
      } else if (decodedBytes !== entry.request.bytes) fail('E_HYA_RUNTIME_HOST_PORT', 'decoded image dimensions do not match prepared source metadata');
      handle = await this.engine.assetManager!.loadTexture(image.value, {signal: entry.controller.signal, premultipliedAlpha: this.options.alphaMode !== 'straight', mipmaps: 'none', label: this.recoveryLabel});
      aborted(entry.controller.signal);
      entry.image = image; image = undefined; entry.handle = handle; handle = undefined; entry.state = 'ready'; entry.resolve(); this.notify('texture-ready');
    } catch (error) {entry.error = error; entry.state = 'failed'; entry.reject(error); if (!entry.retired) this.notify('texture-failed');}
    finally {
      try {handle?.release();} catch (error) {this.report(error);}
      try {image?.release();} catch (error) {this.report(error);}
      this.active--; if (entry.retired) this.collect(entry); this.pump();
    }
  }
  private acquire(entry: Entry): ProductionDrawTexture {
    this.live(); if (entry.state === 'failed') throw entry.error;
    if (entry.state !== 'ready') throw new ProductionTexturePending(entry.ready);
    entry.refs++; this.acquired++; let released = false;
    return Object.freeze({get texture() {if (released || entry.removed) return fail('E_HYA_RUNTIME_DISPOSED', 'draw texture lease was released'); return entry.handle!.value;}, alphaMode: this.options.alphaMode ?? 'premultiplied', ...(entry.request.sampling ? {sampling: entry.request.sampling} : {}),
      release: () => {if (released) return; released = true; entry.refs--; this.released++; this.collect(entry);}});
  }
  private retirePart(part: string): void {for (const entry of [...this.current.values()]) if (entry.request.part === part) this.retire(entry);}
  private retire(entry: Entry): void {
    if (entry.retired) return; entry.retired = true; this.current.delete(entry.request.key); entry.controller.abort();
    if (entry.state === 'queued') {const index = this.queue.indexOf(entry); if (index >= 0) this.queue.splice(index, 1); entry.state = 'failed'; entry.error = new ProductionDrawError('E_HYA_RUNTIME_ABORTED', '$.draw.textures', 'queued texture generation retired'); entry.reject(entry.error);}
    this.collect(entry);
  }
  private collect(entry: Entry): void {
    if (!entry.retired || entry.refs || entry.state === 'loading' || entry.removed) return;
    entry.removed = true; this.retained.delete(entry); this.bytes -= entry.request.bytes; delete entry.decode;
    try {entry.handle?.release();} catch (error) {this.report(error);}
    try {entry.image?.release();} catch (error) {this.report(error);}
    delete entry.handle; delete entry.image;
  }
  private live(checkLoss = true): void {if (this.disposed) fail('E_HYA_RUNTIME_DISPOSED', 'texture owner is disposed'); if (checkLoss && this.lost) fail('E_HYA_RUNTIME_HOST_PORT', 'texture owner is waiting for device recovery');}
  private changed(reason: string): void {this.version++; this.notify(reason);}
  private notify(reason: string): void {if (this.disposed) return; try {this.options.invalidate?.(reason);} catch (error) {this.report(error);}}
  private report(error: unknown): void {this.failures.push(error); if (this.failures.length > 16) this.failures.shift(); try {this.options.diagnostic?.(error);} catch {/* Diagnostic callbacks cannot replay cleanup. */}}
  get stats(): Readonly<{preparedTextures: number; retainedTextures: number; pending: number; queued: number; active: number; refs: number; acquired: number; released: number; textureBytes: number; bitmapBytes: number; cleanupErrors: number; disposed: boolean}> {
    return Object.freeze({preparedTextures: this.current.size, retainedTextures: this.retained.size, pending: this.queue.length + this.active, queued: this.queue.length, active: this.active,
      refs: [...this.retained].reduce((sum, entry) => sum + entry.refs, 0), acquired: this.acquired, released: this.released, textureBytes: this.bytes, bitmapBytes: this.bytes, cleanupErrors: this.failures.length, disposed: this.disposed});
  }
}
function rgbaBytes(width: unknown, height: unknown): number {
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || !Number.isSafeInteger(width * height * 4))
    return fail('E_HYA_RUNTIME_LIMIT', 'image dimensions must be positive safe integers');
  return width * height * 4;
}
function aborted(signal: AbortSignal): void {if (signal.aborted) fail('E_HYA_RUNTIME_ABORTED', 'texture generation was retired');}
function browserTextureHost(): ProductionTextureHost {
  const snapshot = async (source: unknown, signal: AbortSignal): Promise<DecodedImage> => {
    aborted(signal); if (typeof globalThis.createImageBitmap !== 'function') fail('E_HYA_RUNTIME_HOST_PORT', 'this host requires an explicit image decode/snapshot port');
    // Preserve native premultiplied glyph coverage; encoded blobs still decode straight.
    const premultiplyAlpha = typeof globalThis.Blob === 'function' && source instanceof globalThis.Blob ? 'none' : 'premultiply';
    const value = await globalThis.createImageBitmap(source as ImageBitmapSource, {premultiplyAlpha, colorSpaceConversion: 'none'});
    if (signal.aborted) {value.close(); aborted(signal);}
    let released = false; return Object.freeze({value, release() {if (released) return; released = true; value.close();}});
  };
  return Object.freeze({snapshot, decode(bytes: Uint8Array, signal: AbortSignal) {return snapshot(new Blob([bytes.slice().buffer]), signal);}});
}

export {browserTextureHost as createProductionBrowserTextureHost};
