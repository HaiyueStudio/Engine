import { RenderGraph } from '@haiyue/engine/experimental';
import type { RayTraversalDispatchPlan, RayTraversalDispatchPlanPass } from './types.js';

export function createRayTraversalDispatchPlan(rayCount: number, maxRaysPerDispatch: number): RayTraversalDispatchPlan {
  if (!Number.isInteger(rayCount) || rayCount < 0) throw new RangeError('rayCount must be a non-negative integer.');
  if (!Number.isInteger(maxRaysPerDispatch) || maxRaysPerDispatch < 1) throw new RangeError('maxRaysPerDispatch must be a positive integer.');
  const dispatchCount = Math.ceil(rayCount / maxRaysPerDispatch);
  const graph = new RenderGraph<RayTraversalDispatchPlanPass, string>();
  const uploaded = graph.addResource({ name: 'ray.uploaded-inputs', payload: 'inputs', transient: true });
  const uploadPayload = Object.freeze({ kind: 'upload', label: 'ray.upload', dispatchIndex: null }) as RayTraversalDispatchPlanPass;
  const upload = graph.addPass({ name: uploadPayload.label, passClass: 'view-local', payload: uploadPayload });
  graph.write(upload, uploaded);
  const traversalPasses: number[] = [];
  const outputs: number[] = [];
  for (let index = 0; index < dispatchCount; index++) {
    const payload = Object.freeze({ kind: 'traversal', label: `ray.traversal.${index}`, dispatchIndex: index }) as RayTraversalDispatchPlanPass;
    const pass = graph.addPass({ name: payload.label, passClass: 'view-local', payload });
    const output = graph.addResource({ name: `ray.hits.${index}`, payload: `hits:${index}`, transient: true });
    graph.read(pass, uploaded);
    graph.write(pass, output);
    graph.dependsOn(pass, traversalPasses[index - 1] ?? upload);
    traversalPasses.push(pass);
    outputs.push(output);
  }
  const consumerPayload = Object.freeze({ kind: 'consumer', label: 'ray.consumer', dispatchIndex: null }) as RayTraversalDispatchPlanPass;
  const consumer = graph.addPass({ name: consumerPayload.label, passClass: 'view-local', payload: consumerPayload, sideEffect: true });
  for (const output of outputs) graph.read(consumer, output);
  graph.dependsOn(consumer, traversalPasses.at(-1) ?? upload);
  const passes = Object.freeze(graph.compile().map(pass => pass.payload));
  return Object.freeze({ rayCount, maxRaysPerDispatch, dispatchCount, passes });
}
