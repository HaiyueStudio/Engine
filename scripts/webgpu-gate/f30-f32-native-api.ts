// Private fixture facade: test the original owners without adding package exports.
export {Entity, World} from '../../engine/src/ecs';
export {Transform2D, Camera2D} from '../../engine/src/components';
export {Geometry3D} from '../../engine/src/geometry/Geometry3D';
export {ToonMaterial} from '../../engine/src/material/ToonMaterial';
export {ToonRenderer} from '../../engine/src/renderer/ToonRenderer';
export {BaseRenderer} from '../../engine/src/renderer/BaseRenderer';
export {PipelineWarmupPlan} from '../../engine/src/renderer/PipelineWarmup';
export {RenderFrameContext} from '../../engine/src/core/RenderCommandContext';
export {GPUResourceTracker, createGPUResourceOwner} from '../../engine/src/core/GPUResourceTracker';
export {disposeSceneFrameGpuArena} from '../../engine/src/renderer/SceneFrameGpuArena';
export {RendererResourceCache} from '../../engine/src/renderer/RendererResourceCache';
export {parseAnimation} from '../../animation-spec/src/parser';
export {Animation2DRuntime} from '../../extensions/src/animation/Animation2DRuntime';
export {ProductionCoreStateVisualRuntime} from '../../extensions/src/animation/production/ProductionCoreStateVisualRuntime';
export {compileProductionCoreDrawPlan} from '../../extensions/src/animation/production/ProductionCoreDrawPlan';
export {ProductionDrawOwner} from '../../extensions/src/animation/layout/production/ProductionDrawOwner';
