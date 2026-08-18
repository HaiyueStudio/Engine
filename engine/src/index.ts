/// <reference path="./types/wgsl.d.ts" />

// Haiyue's stable golden path. Domain-specific APIs remain available from the
// explicit package subpaths documented in engine/package.json.
export { HaiyueEngine, EngineError, EngineErrorCode } from './core';
export type { HaiyueEngineOptions, RenderProfileName } from './core';

export { Component, Entity, System, World } from './ecs';
export { Scene } from './scene';
export type { SceneOptions } from './scene';

export {
  Camera2D,
  Camera3D,
  CartesianTransform3D,
  Mesh2D,
  Mesh3D,
  SphericalTransform3D,
  Transform2D,
} from './components';

export {
  createBox3D,
  createPlane3D,
  createSphere3D,
  Geometry2D,
  Geometry3D,
} from './geometry';

export { BasicMaterial, Material2D, PbrMaterial } from './material';
export { DirectionalLight, EnvironmentLight } from './lighting';
export { OrbitControl } from './controls';
export { ColorSRGB } from './color';
