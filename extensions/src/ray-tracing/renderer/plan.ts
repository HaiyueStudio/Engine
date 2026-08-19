import { RenderGraph } from '@haiyue/engine/experimental';
import type { RayPathRenderPlan, RayPathRenderPlanPass } from './types.js';

export function createRayPathRenderPlan(width: number, height: number): RayPathRenderPlan {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError('Ray path render dimensions must be positive integers.');
  }
  const graph = new RenderGraph<RayPathRenderPlanPass, string>();
  const facts = graph.addResource({ name: 'ray.path.uploaded-facts', payload: 'facts', transient: true });
  const hdr = graph.addResource({ name: 'ray.path.hdr', payload: 'hdr', transient: true });
  const output = graph.addResource({ name: 'ray.path.output', payload: 'output', transient: false });
  const uploadPayload = Object.freeze({ kind: 'upload', label: 'ray.path.upload' }) as RayPathRenderPlanPass;
  const tracePayload = Object.freeze({ kind: 'path-tracing', label: 'ray.path.trace' }) as RayPathRenderPlanPass;
  const tonePayload = Object.freeze({ kind: 'tone-mapping', label: 'ray.path.tone-map' }) as RayPathRenderPlanPass;
  const consumerPayload = Object.freeze({ kind: 'consumer', label: 'ray.path.consumer' }) as RayPathRenderPlanPass;
  const upload = graph.addPass({ name: uploadPayload.label, passClass: 'view-local', payload: uploadPayload });
  const trace = graph.addPass({ name: tracePayload.label, passClass: 'view-local', payload: tracePayload });
  const tone = graph.addPass({ name: tonePayload.label, passClass: 'view-local', payload: tonePayload });
  const consumer = graph.addPass({ name: consumerPayload.label, passClass: 'view-local', payload: consumerPayload, sideEffect: true });
  graph.write(upload, facts);
  graph.read(trace, facts); graph.write(trace, hdr); graph.dependsOn(trace, upload);
  graph.read(tone, hdr); graph.write(tone, output); graph.dependsOn(tone, trace);
  graph.read(consumer, output); graph.dependsOn(consumer, tone);
  return Object.freeze({ width, height, passes: Object.freeze(graph.compile().map(pass => pass.payload)) });
}
