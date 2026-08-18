import fogWgsl from '../shaders/generated/material-lighting-fog.generated.wgsl';
import morphWgsl from '../shaders/generated/deformation-morph.generated.wgsl';
import pbrBrdfWgsl from '../shaders/generated/material-lighting-pbr-brdf.generated.wgsl';
import skinningWgsl from '../shaders/generated/deformation-skinning.generated.wgsl';
import { defineWgslFeatureModule } from './WgslFeatureComposer';
import { SCENE_FRAME_UNIFORM_WGSL } from '../frame/SceneFrameUniformLayout';

export const fogShaderFeature = defineWgslFeatureModule({
  id: 'scene.fog',
  source: fogWgsl,
  sourceName: 'shaders/generated/material-lighting-fog.generated.wgsl',
  exports: ['FogUniforms', 'fogAmount', 'applyFog'],
});

export const sceneFrameShaderFeature = defineWgslFeatureModule({
  id: 'scene.frame-uniforms',
  source: SCENE_FRAME_UNIFORM_WGSL,
  sourceName: 'generated/SceneFrameUniforms.wgsl',
  dependencies: [fogShaderFeature],
  exports: ['SceneFrameUniforms'],
});

export const morphShaderFeature = defineWgslFeatureModule({
  id: 'vertex.morph',
  source: morphWgsl,
  sourceName: 'shaders/generated/deformation-morph.generated.wgsl',
  exports: ['applyMorphPosition', 'applyMorphNormal'],
});

export const skinningShaderFeature = defineWgslFeatureModule({
  id: 'vertex.skinning',
  source: skinningWgsl,
  sourceName: 'shaders/generated/deformation-skinning.generated.wgsl',
  dependencies: [morphShaderFeature],
  exports: [
    'SkinUniforms',
    'SkinAttributes',
    'skin',
    'skinJoints',
    'skinWeights',
    'skinPosition',
    'skinNormal',
    'safeNormalize',
  ],
});

export const pbrBrdfShaderFeature = defineWgslFeatureModule({
  id: 'pbr.brdf',
  source: pbrBrdfWgsl,
  sourceName: 'shaders/generated/material-lighting-pbr-brdf.generated.wgsl',
  exports: [
    'PI',
    'distributionGGX',
    'geometrySchlickGGX',
    'geometrySmith',
    'fresnelSchlick',
    'fresnelSchlickF90',
    'fresnelSchlickRoughness',
    'fresnelSchlickRoughnessF90',
  ],
});
