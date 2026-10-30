/** Named runtime contracts for facade orchestration. Type-only imports are checked separately by TypeScript. */
const pipelineContracts = new Set([
  'core/IEngine.ts',
  'core/EngineDiagnosticsAccess.ts',
  'core/RenderCommandContext.ts',
  'core/RenderView.ts',
  'core/renderPassDescriptor.ts',
  'ecs/World.ts',
  'renderer/frame-plan/RenderFramePlan.ts',
  'renderer/frame-plan/RenderPassCompatibility.ts',
  'renderer/regions/RegionExecution.ts',
]);

export function engineLayerViolation(from,to) {
  if(from.startsWith('scene/internal/')&&to==='scene/Scene.ts')return `${from} imports concrete facade ${to}`;
  if(from==='renderer/RenderPipeline.ts'&&!pipelineContracts.has(to))return `${from} imports non-contract module ${to}`;
  if(from.startsWith('core/')&&from!=='core/Engine.ts'&&to==='scene/Scene.ts')return `${from} reverses the core -> scene facade dependency`;
  return null;
}
