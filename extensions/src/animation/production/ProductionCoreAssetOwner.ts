import type {AnimationBinaryResource, AnimationImageResource, AnimationResource} from '@haiyue/animation-spec';
import type {AssetHandle} from '@haiyue/engine/assets';
import type {IEngine} from '@haiyue/engine/extension-authoring';
import type {AnimationVisual2D} from '../AnimationVisual2D.js';
import {parseAnimationCoreExpressionData, type Animation2DCoreResourcePort} from '../Animation2DRuntime.js';
import {LayoutAssetOwner, normalizeLayoutAssetIntegrity, type LayoutAssetOwnerOptions} from '../layout/parameterized/AssetOwner.js';
import type {RuntimeAsset, RuntimeAssetSource} from '../layout/parameterized/runtime-types.js';
import {ProductionTextureOwner, ProductionTexturePending, createProductionBrowserTextureHost, type ProductionEncodedImage, type ProductionTextureOptions} from '../layout/production/ProductionTextureOwner.js';
import type {ProductionDrawTexture} from '../layout/production/ProductionDrawPlan.js';
import {ProductionFrameError} from './FrameTransaction.js';
import {createCoreAssetCatalogue} from './CoreResourceCatalogue.js';

type Source = Extract<RuntimeAssetSource, {kind: 'embedded' | 'referenced'}>;
type Catalogue = Readonly<{assets: readonly RuntimeAsset[]}>;
type Image = Readonly<{key: string; source: ProductionEncodedImage}>;
export interface ProductionCoreAssetOptions extends Pick<LayoutAssetOwnerOptions, 'policy' | 'resolver' | 'maxAssetBytes' | 'maxTotalBytes'> {
  readonly sources?: Readonly<Record<string, Source>>;
  readonly textures: Omit<ProductionTextureOptions, 'alphaMode'>;
}
let nextOwner = 0;
const fail = (code: string, id: string, message: string): never => {throw new ProductionFrameError(code, '$.core.resources[' + JSON.stringify(id) + ']', message);};

/** Production core adapter over the original SHA/network owner, texture queue and Engine cache. */
export class ProductionCoreAssetOwner implements Animation2DCoreResourcePort {
  private readonly assets: LayoutAssetOwner<Catalogue>;
  private readonly textures: ProductionTextureOwner;
  private readonly definitions: ReadonlyMap<string, Readonly<AnimationResource>>;
  private readonly images = new Map<string, Promise<Image>>();
  private readonly imageSources = new Map<string, ProductionEncodedImage>();
  private readonly controller = new AbortController();
  private readonly prefix = 'HYA.core.assets:' + ++nextOwner + ':';
  private readonly maxSourceBytes: number;
  private sourceBytes = 0;
  private disposed = false;
  constructor(resources: readonly Readonly<AnimationResource>[], private readonly engine: IEngine, options: ProductionCoreAssetOptions) {
    if (!engine.assetManager || typeof engine.assetManager.load !== 'function') fail('E_HYA_RUNTIME_HOST_PORT', '', 'an initialized public Engine AssetManager is required');
    const {definitions,assets}=createCoreAssetCatalogue(resources,options.sources);
    this.maxSourceBytes = options.maxTotalBytes ?? 1024 * 1024 * 1024;
    this.definitions = definitions;
    this.assets = new LayoutAssetOwner<Catalogue>({assets}, options);
    try {
      this.textures = new ProductionTextureOwner(engine, new Map(), {...options.textures,
        host: options.textures.host ?? createProductionBrowserTextureHost(), alphaMode: 'straight'});
    } catch (error) {this.assets.dispose(); throw error;}
  }
  async loadBinary(resource: Readonly<AnimationBinaryResource>, signal: AbortSignal): Promise<AssetHandle<ArrayBuffer>> {
    this.definition(resource, 'binary');
    return this.binary(resource, 'font', bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, signal);
  }
  async loadExpressionData(resource: Readonly<AnimationBinaryResource>, signal: AbortSignal): Promise<AssetHandle<unknown>> {
    this.definition(resource, 'binary');
    if (!/^application\/json(?:$|;)/iu.test(resource.mimeType ?? '')) fail('E_HYA_RUNTIME_RESOURCE', resource.id, 'expression data must declare application/json');
    return this.binary(resource, 'expression-data', bytes => parseAnimationCoreExpressionData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer), signal);
  }
  private async binary<T>(resource: Readonly<AnimationBinaryResource>, kind: string, decode: (bytes: Uint8Array) => T, signal: AbortSignal): Promise<AssetHandle<T>> {
    this.live(); aborted(signal); const bytes = await this.assets.load(resource.id, {signal}); let handle: AssetHandle<T> | undefined;
    const scope = link(signal, this.controller.signal);
    try {
      this.live(); aborted(signal);
      const key = 'HYA.production.core.binary@1:' + kind + ':' + normalizeLayoutAssetIntegrity(resource.integrity!);
      handle = await this.engine.assetManager!.load<T>(key, async () => decode(bytes.bytes), () => {}, {signal: scope.signal});
      this.live(); aborted(signal); const result = handle; handle = undefined; return result;
    } catch (error) {this.live(); aborted(signal); throw error;}
    finally {scope.release(); handle?.release(); bytes.release();}
  }
  async loadTexture(resource: Readonly<AnimationImageResource>, signal: AbortSignal): Promise<AssetHandle<GPUTexture>> {
    this.definition(resource, 'image'); this.live(); aborted(signal);
    let job = this.images.get(resource.id);
    if (!job) {
      job = this.image(resource); this.images.set(resource.id, job); void job.catch(() => {});
    }
    const image = await wait(job, signal, this.controller.signal); this.live(); aborted(signal);
    let lease: ProductionDrawTexture;
    try {lease = this.textures.encodedImage(image.source);} catch (error) {
      if (!(error instanceof ProductionTexturePending)) throw error;
      await wait(error.ready, signal, this.controller.signal); this.live(); aborted(signal); lease = this.textures.encodedImage(image.source);
    }
    try {this.live(); aborted(signal);} catch (error) {lease.release(); throw error;}
    // This wrapper owns one acquired lease. A frame must acquire another via acquireImage().
    return Object.freeze({key: image.key, get value() {return lease.texture;}, release: lease.release});
  }
  private async image(resource: Readonly<AnimationImageResource>): Promise<Image> {
    const handle = await this.assets.load(resource.id, {signal: this.controller.signal});
    try {
      this.live();
      if (this.sourceBytes + handle.bytes.byteLength > this.maxSourceBytes) fail('E_HYA_RUNTIME_LIMIT', resource.id, 'owned encoded core images exceed the existing source-byte ceiling');
      const source: ProductionEncodedImage = Object.freeze({value: handle.bytes, generation: handle.generation, bytes: handle.bytes.byteLength,
        ...(resource.width === undefined ? {} : {width: resource.width}), ...(resource.height === undefined ? {} : {height: resource.height})});
      const key = this.prefix + JSON.stringify([resource.id, handle.generation]);
      this.sourceBytes += handle.bytes.byteLength; this.imageSources.set(key, source); return Object.freeze({key, source});
    } finally {handle.release();}
  }
  /** One independent lease per immutable frame, using the same original texture owner. */
  acquireImage(visual: AnimationVisual2D): ProductionDrawTexture {
    this.live(); const key = visual.textureHandle?.key, source = (key ? this.imageSources.get(key) : undefined) ?? fail('E_HYA_RUNTIME_REFERENCE', key ?? '', 'visual is not owned by this core asset adapter');
    return this.textures.encodedImage(source);
  }
  private definition(resource: Readonly<AnimationResource>, type: 'binary' | 'image'): void {
    this.live(); const expected = this.definitions.get(resource.id);
    if (!expected || expected.type !== type || resource.type !== type || expected.uri !== resource.uri
      || typeof resource.integrity !== 'string' || normalizeLayoutAssetIntegrity(expected.integrity!) !== normalizeLayoutAssetIntegrity(resource.integrity))
      fail('E_HYA_RUNTIME_REFERENCE', resource.id, 'core request does not match its frozen resource declaration');
    if (expected?.type === 'image' && resource.type === 'image' && (expected.width !== resource.width || expected.height !== resource.height || expected.mimeType !== resource.mimeType)
      || expected?.type === 'binary' && resource.type === 'binary' && expected.mimeType !== resource.mimeType)
      fail('E_HYA_RUNTIME_REFERENCE', resource.id, 'core request changes frozen resource metadata');
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.controller.abort();
    const errors: unknown[] = []; try {this.assets.dispose();} catch (error) {errors.push(error);} try {this.textures.dispose();} catch (error) {errors.push(error);}
    this.images.clear(); this.imageSources.clear(); this.sourceBytes = 0;
    if (errors.length) throw new AggregateError(errors, 'Core resource adapter disposal failed');
  }
  get stats() {return Object.freeze({disposed: this.disposed, sourceBytes: this.sourceBytes, images: this.images.size, assets: this.assets.stats, textures: this.textures.stats});}
  private live(): void {if (this.disposed) throw new ProductionFrameError('E_HYA_RUNTIME_DISPOSED', '$.core.resources', 'core resource adapter is disposed');}
}
function aborted(signal: AbortSignal): void {if (signal.aborted) throw new ProductionFrameError('E_HYA_RUNTIME_ABORTED', '$.core.resources', 'core resource acquisition was cancelled');}
async function wait<T>(promise: Promise<T>, signal: AbortSignal, owner: AbortSignal): Promise<T> {
  aborted(signal); if (owner.aborted) throw new ProductionFrameError('E_HYA_RUNTIME_DISPOSED', '$.core.resources', 'core resource adapter is disposed'); let remove = (): void => {};
  const cancellation = new Promise<never>((_resolve, reject) => {const abort = (): void => reject(new ProductionFrameError('E_HYA_RUNTIME_ABORTED', '$.core.resources', 'core resource acquisition was cancelled')),
      dispose = (): void => reject(new ProductionFrameError('E_HYA_RUNTIME_DISPOSED', '$.core.resources', 'core resource adapter is disposed'));
    signal.addEventListener('abort', abort, {once: true}); owner.addEventListener('abort', dispose, {once: true}); remove = () => {signal.removeEventListener('abort', abort); owner.removeEventListener('abort', dispose);}; if (signal.aborted) abort(); else if (owner.aborted) dispose();});
  try {return await Promise.race([promise, cancellation]);} finally {remove();}
}
function link(request: AbortSignal, owner: AbortSignal): {readonly signal: AbortSignal; release(): void} {
  const controller = new AbortController(), abort = (): void => controller.abort();
  request.addEventListener('abort', abort, {once: true}); owner.addEventListener('abort', abort, {once: true}); if (request.aborted || owner.aborted) abort();
  return {signal: controller.signal, release() {request.removeEventListener('abort', abort); owner.removeEventListener('abort', abort);}};
}
