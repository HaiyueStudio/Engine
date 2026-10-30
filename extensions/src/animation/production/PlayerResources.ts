import type {HyaResourcePort} from '@haiyue/extensions/hya-player';
import type {AnimationResource} from '@haiyue/animation-spec';
import {normalizeLayoutAssetIntegrity,type LayoutAssetResolver} from '../layout/parameterized/AssetOwner.js';
import type {RuntimeLayoutDocument,RuntimeAssetSource} from '../layout/parameterized/runtime-types.js';
import {ProductionFrameError} from './FrameTransaction.js';
type Request=Parameters<HyaResourcePort['acquire']>[0];
/** The original SHA/byte owners remain authoritative; this bridge only copies an acquired host lease. */
export async function resourceBytes(port:HyaResourcePort|undefined,request:Request):Promise<Uint8Array>{
 if(request.signal.aborted)throw new ProductionFrameError('E_HYA_RUNTIME_ABORTED','$.resources','resource request was cancelled');
 if(!port||typeof port.acquire!=='function')throw new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT','$.resources['+JSON.stringify([request.part,request.asset])+']','the declared external asset requires the host resource port');
 const handle=await port.acquire(Object.freeze({...request}));
 try{
  if(!handle||typeof handle.release!=='function')throw new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT','$.resources','acquire must return a release lease');
  if(request.signal.aborted)throw new ProductionFrameError('E_HYA_RUNTIME_ABORTED','$.resources','late resource was cancelled');
  const value=handle.value;
  if(!(value instanceof Uint8Array)&&!(value instanceof ArrayBuffer))throw new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT','$.resources','encoded resources require ArrayBuffer or Uint8Array bytes');
  const count=value.byteLength;
  if(!Number.isSafeInteger(handle.generation)||handle.generation<0||!Number.isSafeInteger(handle.bytes)||handle.bytes<count)throw new ProductionFrameError('E_HYA_RUNTIME_RESOURCE','$.resources','resource lease generation/byte accounting is invalid');
  return value instanceof Uint8Array?new Uint8Array(value):new Uint8Array(value.slice(0));
 }finally{handle?.release?.();}
}
const origin='https://hya.invalid';
function route(part:string,entries:readonly Readonly<{id:string;kind:Request['kind'];integrity:string}>[],port:HyaResourcePort|undefined){
 const byUri=new Map(entries.map(e=>[origin+'/'+encodeURIComponent(part)+'/'+encodeURIComponent(e.id),e]));
 const uri=(id:string)=>origin+'/'+encodeURIComponent(part)+'/'+encodeURIComponent(id);
 const resolver:LayoutAssetResolver={resolve:(uri,signal)=>{const entry=byUri.get(uri);if(!entry)throw new ProductionFrameError('E_HYA_RUNTIME_REFERENCE','$.resources','resource URI is not a declared part/asset');return resourceBytes(port,{kind:entry.kind,part,asset:entry.id,integrity:normalizeLayoutAssetIntegrity(entry.integrity),signal});}};
 return{uri,options:{policy:{mode:'allow-list' as const,baseUrl:origin,origins:Object.freeze([origin])},resolver}};
}
export function createLayoutResourceRoute(part:string,document:RuntimeLayoutDocument,port:HyaResourcePort|undefined){
 const entries=document.assets.flatMap(a=>a.kind==='folder'||a.source.kind==='embedded'||a.source.kind==='hosted'?[]:[{id:a.id,kind:(['font','image','audio'].includes(a.kind)?a.kind:'blob') as Request['kind'],integrity:a.source.integrity}]);
 const r=route(part,entries,port),assets=document.assets.map(a=>a.kind==='folder'||a.source.kind!=='referenced'?a:Object.freeze({...a,source:Object.freeze({...a.source,uri:r.uri(a.id)})}));
 return Object.freeze({document:Object.freeze({...document,assets:Object.freeze(assets)}),options:Object.freeze(r.options)});
}
export function createCoreResourceRoute(part:string,resources:readonly Readonly<AnimationResource>[],port:HyaResourcePort|undefined){
 const entries=resources.filter(r=>r.type!=='audio').map(r=>({id:r.id,kind:(r.type==='image'?'image':r.mimeType?.startsWith('application/json')?'blob':'font') as Request['kind'],integrity:typeof r.integrity==='string'?r.integrity:''}));
 for(const e of entries)if(!e.integrity)throw new ProductionFrameError('E_HYA_RUNTIME_RESOURCE','$.parts.'+part+'.resources.'+e.id,'production encoded bytes require declared SHA-256 integrity');
 const r=route(part,entries,port),sources:Record<string,Extract<RuntimeAssetSource,{kind:'referenced'}>>={};for(const e of entries)sources[e.id]=Object.freeze({kind:'referenced',uri:r.uri(e.id),integrity:e.integrity});
 return Object.freeze({...r.options,sources:Object.freeze(sources)});
}
