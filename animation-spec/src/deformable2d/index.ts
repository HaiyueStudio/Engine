export {
  DEFORMABLE_MESH_2D_DATA_FORMAT,
  DEFORMABLE_MESH_2D_DATA_VERSION,
  DEFORMABLE_MESH_2D_EXTENSION_ID,
} from './types';
export type {
  DeformableMesh2DBlendMode,
  DeformableMesh2DComponent,
  DeformableMesh2DDataSource,
  DeformableMesh2DDrawableSource,
  DeformableMesh2DParseLimits,
  ParsedDeformableMesh2DData,
  ParsedDeformableMesh2DDrawable,
} from './types';
export {
  decodeDeformableMesh2DData,
  encodeDeformableMesh2DData,
  isDeformableMesh2DBinary,
} from './codec';
export {
  createDeformableMesh2DFormatHandler,
  createDeformableMesh2DFormatRegistry,
} from './extension';

