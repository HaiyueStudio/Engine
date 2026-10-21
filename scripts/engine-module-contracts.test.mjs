import test from 'node:test';
import assert from 'node:assert/strict';
import {engineLayerViolation} from './engine-module-contracts.mjs';

test('pipeline delegates regional execution only through the named contract',()=>{
 const owner='renderer/RenderPipeline.ts';assert.equal(engineLayerViolation(owner,'renderer/regions/RegionExecution.ts'),null);
 for(const target of ['renderer/regions/RegionPipeline.ts','renderer/regions/RegionColorTarget.ts','renderer/regions/RegionCacheBudget.ts','gui/systems/GuiSystem.ts','postprocess/SceneOutputPass.ts'])assert.match(engineLayerViolation(owner,target),/non-contract module/);
 assert.equal(engineLayerViolation(owner,'renderer/frame-plan/RenderFramePlan.ts'),null);
 assert.equal(engineLayerViolation(owner,'renderer/frame-plan/RenderPassCompatibility.ts'),null);
});
test('regional delegation does not permit reverse scene facade dependencies',()=>{
 assert.match(engineLayerViolation('core/RenderView.ts','scene/Scene.ts'),/reverses/);
 assert.match(engineLayerViolation('scene/internal/SceneBootstrap.ts','scene/Scene.ts'),/concrete facade/);
 assert.equal(engineLayerViolation('core/Engine.ts','scene/Scene.ts'),null);
 assert.equal(engineLayerViolation('renderer/regions/RegionPipeline.ts','core/RenderView.ts'),null);
});
