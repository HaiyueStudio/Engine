import type {AnimationBinaryResource, AnimationResource} from '@haiyue/animation-spec';
import type {AssetHandle} from '@haiyue/engine/assets';
import {LayoutAssetOwner, type LayoutAssetOwnerOptions} from '../layout/parameterized/AssetOwner.js';
import {parseAnimationCoreExpressionData, type Animation2DCoreResourcePort} from '../Animation2DRuntime.js';
import {createCoreAssetCatalogue} from './CoreResourceCatalogue.js';
import type {RuntimeAsset,RuntimeAssetSource} from '../layout/parameterized/runtime-types.js';
import {ProductionFrameError} from './FrameTransaction.js';

type Source = Extract<RuntimeAssetSource, {kind:'embedded'|'referenced'}>;
type Options = LayoutAssetOwnerOptions & {readonly sources?: Readonly<Record<string,Source>>};

/** CPU expression bytes use the same catalogue and SHA/limit/lease owner as render resources. */
export class ProductionCoreEvaluationAssets implements Animation2DCoreResourcePort {
  private readonly assets: LayoutAssetOwner<{readonly assets:readonly RuntimeAsset[]}>;
  private readonly definitions: ReturnType<typeof createCoreAssetCatalogue>['definitions'];
  private disposed = false;
  constructor(resources: readonly Readonly<AnimationResource>[], options: Options) {
    const catalogue = createCoreAssetCatalogue(resources, options.sources);
    this.definitions = catalogue.definitions;
    this.assets = new LayoutAssetOwner({assets:catalogue.assets}, options);
  }
  loadTexture(): Promise<never> {return Promise.reject(this.hostError('image'));}
  loadBinary(resource:Readonly<AnimationBinaryResource>,signal:AbortSignal):Promise<AssetHandle<ArrayBuffer>> {
    return this.binary(resource,signal,bytes=>bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength&&bytes.buffer instanceof ArrayBuffer?bytes.buffer:bytes.slice().buffer as ArrayBuffer);
  }
  loadExpressionData(resource: Readonly<AnimationBinaryResource>, signal: AbortSignal): Promise<AssetHandle<unknown>> {
    if(!/^application\/json(?:$|;)/iu.test(resource.mimeType??''))throw new ProductionFrameError('E_HYA_RUNTIME_RESOURCE','$.core.resources.'+resource.id,'expression data must declare application/json');
    return this.binary(resource,signal,bytes=>parseAnimationCoreExpressionData(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer));
  }
  private async binary<T>(resource:Readonly<AnimationBinaryResource>,signal:AbortSignal,decode:(bytes:Uint8Array)=>T):Promise<AssetHandle<T>> {
    if(this.disposed)throw new ProductionFrameError('E_HYA_RUNTIME_DISPOSED','$.core.resources','CPU resources are disposed');
    const declared=this.definitions.get(resource.id);
    if(!declared || declared.type!=='binary' || declared.uri!==resource.uri || declared.integrity!==resource.integrity)
      throw new ProductionFrameError('E_HYA_RUNTIME_RESOURCE','$.core.resources.'+resource.id,'CPU bytes must address the declared binary resource');
    const lease=await this.assets.load(resource.id,{signal});let transferred=false;
    try {
      if(this.disposed||signal.aborted)throw new ProductionFrameError('E_HYA_RUNTIME_ABORTED','$.core.resources','CPU resource request was cancelled');
      const value=decode(lease.bytes);
      let released=false;const handle=Object.freeze({key:'HYA.core.CPU:'+resource.id,value,release(){if(!released){released=true;lease.release();}}});
      transferred=true;return handle;
    } finally {if(!transferred)lease.release();}
  }
  dispose(): void {if(this.disposed)return;this.disposed=true;this.assets.dispose();}
  get stats(){return this.assets.stats;}
  private hostError(kind:string): ProductionFrameError {return new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT','$.core.'+kind,'CPU evaluation cannot materialize a raster resource');}
}
