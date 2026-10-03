import type { PostProcessPass } from './PostProcessPass';
import type { TransientTextureAllocator, TransientTextureRequest } from '../rtt/TransientTextureAllocator';
import { getPostProcessSubmission } from './PostProcessSubmission';

const owners = new WeakMap<PostProcessPass, { pool: TransientTextureAllocator; id: number }>();
let nextId = 0;

/** Private owner attachment; custom effect contracts are unchanged. */
export function setPostProcessTransientTextures(pass: PostProcessPass, pool: TransientTextureAllocator): void {
  if (owners.get(pass)?.pool !== pool) owners.set(pass, { pool, id: ++nextId });
}
export function clearPostProcessTransientTextures(pass: PostProcessPass): void { owners.delete(pass); }
export function hasPostProcessTransientTextures(pass: PostProcessPass): boolean { return owners.has(pass); }
export function acquirePostProcessTransientTextures(pass: PostProcessPass, device: GPUDevice, encoder: GPUCommandEncoder,
  requests: readonly TransientTextureRequest[]) {
  const owner = owners.get(pass);
  if (!owner) return undefined;
  const afterSubmit = getPostProcessSubmission(pass);
  if (!afterSubmit) throw Error('Managed postprocess scratch needs a submission boundary.');
  return owner.pool.acquire(requests.map(request => ({ ...request, name: `${owner.id}:${request.name}` })), { device, encoder, afterSubmit });
}
