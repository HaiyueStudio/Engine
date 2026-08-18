import {
  createGltfAnimation3DClips,
  createGltfAnimation3DRuntime,
  type GltfAnimation3DRuntime,
} from '../src/gltf-animation3d';
import type { LoadedGltfModel } from '../src/gltf';
import type {
  Animation3DClip,
  Animation3DMixer,
  Animation3DPose,
  Animation3DPoseBuffer,
} from '../src/animation3d';

// @ts-expect-error The glTF binding resolver is adapter-owned.
import type { GltfAnimation3DBindingResolver } from '../src/gltf-animation3d';
// @ts-expect-error The glTF pose applier is adapter-owned.
import type { GltfAnimation3DPoseApplier } from '../src/gltf-animation3d';

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends
  (<T>() => T extends TRight ? 1 : 2)
    ? true
    : false;
type Expect<TValue extends true> = TValue;

declare const model: LoadedGltfModel;
const runtime = createGltfAnimation3DRuntime(model);
const clips = createGltfAnimation3DClips(model);

type _RuntimeMixer = Expect<Equal<typeof runtime.mixer, Animation3DMixer>>;
type _RuntimePoseBuffer = Expect<Equal<typeof runtime.pose, Animation3DPoseBuffer>>;
type _RuntimeUpdate = Expect<Equal<ReturnType<GltfAnimation3DRuntime['update']>, Animation3DPose>>;
type _Clips = Expect<Equal<typeof clips, readonly Animation3DClip[]>>;

runtime.bindingCount;
runtime.targetCount;
runtime.destroy();
void (null as unknown as GltfAnimation3DBindingResolver);
void (null as unknown as GltfAnimation3DPoseApplier);
