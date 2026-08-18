export {
  createAssetWorkerSource,
  createKtx2TextureWorkerSource,
} from '@haiyue/engine/experimental/assets';

export {
  createCSGWorkerSource,
} from '@haiyue/engine/geometry';

export function resolveWorkerUrl(baseUrl) {
  return new URL('./workers/haiyue-consumer-worker.mjs', baseUrl).href;
}
