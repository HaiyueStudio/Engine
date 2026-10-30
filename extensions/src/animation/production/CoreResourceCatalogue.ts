import type {AnimationResource} from '@haiyue/animation-spec';
import {normalizeLayoutAssetIntegrity} from '../layout/parameterized/AssetOwner.js';
import type {RuntimeAsset,RuntimeAssetSource} from '../layout/parameterized/runtime-types.js';
import {ProductionFrameError} from './FrameTransaction.js';
type Source=Extract<RuntimeAssetSource,{kind:'embedded'|'referenced'}>;
const fail=(code:string,id:string,message:string):never=>{throw new ProductionFrameError(code,'$.core.resources['+JSON.stringify(id)+']',message);};
/** One original core catalogue for CPU and render owners. Byte policies and hashes are unchanged. */
export function createCoreAssetCatalogue(resources:readonly Readonly<AnimationResource>[],sources?:Readonly<Record<string,Source>>) {
  if (new Set(resources.map(value => value.id)).size !== resources.length) fail('E_HYA_RUNTIME_REFERENCE', '', 'duplicate core resource ID');
  const definitions = new Map(resources.map(value => [value.id, Object.freeze({...value})]));
  for (const id of Object.keys(sources ?? {})) if (!definitions.has(id)) fail('E_HYA_RUNTIME_REFERENCE', id, 'source override is not declared');
  const assets: RuntimeAsset[] = [];
  for (const value of definitions.values()) {
    if (value.type === 'audio') continue; // Audio keeps its existing dedicated composition owner.
    const integrity = typeof value.integrity === 'string' ? value.integrity : fail('E_HYA_RUNTIME_RESOURCE', value.id, 'production core bytes require declared SHA-256 integrity');
    const expected = normalizeLayoutAssetIntegrity(integrity), supplied = sources?.[value.id];
    if (supplied && normalizeLayoutAssetIntegrity(supplied.integrity) !== expected) fail('E_HYA_RUNTIME_RESOURCE', value.id, 'source integrity differs from the core declaration');
    assets.push({id: value.id, kind: 'blob', source: supplied ?? {kind: 'referenced', uri: value.uri, integrity}});
  }
  return {definitions,assets};
}
