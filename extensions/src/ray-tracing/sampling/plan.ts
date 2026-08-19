import { RenderGraph } from '@haiyue/engine/experimental';

export interface RayProgressivePlanPass { readonly kind: 'sample' | 'accumulate' | 'denoise-temporal' | 'denoise-spatial' | 'present'; readonly label: string }

export function createRayProgressiveRenderPlan(denoise: boolean): readonly RayProgressivePlanPass[] {
  const graph = new RenderGraph<RayProgressivePlanPass, string>();
  const sample = graph.addResource({ name: 'ray.progressive.sample', payload: 'sample', transient: true });
  const history = graph.addResource({ name: 'ray.progressive.history', payload: 'history', transient: false });
  const temporal = graph.addResource({ name: 'ray.progressive.temporal', payload: 'temporal', transient: true });
  const denoised = graph.addResource({ name: 'ray.progressive.denoised', payload: 'denoised', transient: false });
  const output = graph.addResource({ name: 'ray.progressive.output', payload: 'output', transient: false });
  const passes: RayProgressivePlanPass[] = [
    Object.freeze({ kind: 'sample', label: 'ray.progressive.sample' }),
    Object.freeze({ kind: 'accumulate', label: 'ray.progressive.accumulate' }),
  ];
  if (denoise) passes.push(Object.freeze({ kind: 'denoise-temporal', label: 'ray.progressive.denoise.temporal' }), Object.freeze({ kind: 'denoise-spatial', label: 'ray.progressive.denoise.spatial' }));
  passes.push(Object.freeze({ kind: 'present', label: 'ray.progressive.present' }));
  const nodes = passes.map(pass => graph.addPass({ name: pass.label, passClass: 'view-local', payload: pass, sideEffect: pass.kind === 'present' }));
  graph.write(nodes[0]!, sample);
  graph.read(nodes[1]!, sample); graph.write(nodes[1]!, history); graph.dependsOn(nodes[1]!, nodes[0]!);
  if (denoise) {
    graph.read(nodes[2]!, history); graph.write(nodes[2]!, temporal); graph.dependsOn(nodes[2]!, nodes[1]!);
    graph.read(nodes[3]!, temporal); graph.write(nodes[3]!, denoised); graph.dependsOn(nodes[3]!, nodes[2]!);
    graph.read(nodes[4]!, denoised); graph.write(nodes[4]!, output); graph.dependsOn(nodes[4]!, nodes[3]!);
  } else { graph.read(nodes[2]!, history); graph.write(nodes[2]!, output); graph.dependsOn(nodes[2]!, nodes[1]!); }
  return Object.freeze(graph.compile().map(pass => pass.payload));
}
