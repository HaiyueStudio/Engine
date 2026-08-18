export { Geometry3D } from './Geometry3D';
export { GEOMETRY3D_UV_CHANNEL_CAPACITY } from './Geometry3D';
export type { CustomAttribute, Geometry3DBoundsMode, Geometry3DLocalBounds, Geometry3DTextureCoordinateSet, InstanceAttribute, Geometry3DOptions } from './Geometry3D';
export { separateGeometryTriangles } from './SeparateGeometryTriangles';
export { subdivideGeometryTriangles } from './SubdivideGeometryTriangles';
export type { SubdivideGeometryTrianglesOptions } from './SubdivideGeometryTriangles';
export { simplifyGeometryTriangles } from './SimplifyGeometryTriangles';
export type { SimplifyGeometryTrianglesOptions } from './SimplifyGeometryTriangles';
export { createBox3D } from './BoxGeometry';
export type { BoxGeometryOptions } from './BoxGeometry';
export { createRoundedBox3D } from './RoundedBoxGeometry';
export type { RoundedBoxGeometryOptions } from './RoundedBoxGeometry';
export { createSphere3D } from './SphereGeometry';
export type { SphereGeometryOptions } from './SphereGeometry';
export { createCone3D } from './ConeGeometry';
export type { ConeGeometryOptions } from './ConeGeometry';
export { createCylinder3D } from './CylinderGeometry';
export type { CylinderGeometryOptions } from './CylinderGeometry';
export { createTorus3D } from './TorusGeometry';
export type { TorusGeometryOptions } from './TorusGeometry';
export { createIcosahedron3D } from './IcosahedronGeometry';
export { createCSGGeometry, csgUnion, csgSubtract, csgIntersect } from './CSG';
export type { CSGOperation } from './CSG';
export type { CSGPreparedGeometry, CSGWorker } from './CSGWorkerPublic';
export {
  createCSGWorkerClientFromUrl,
  createInlineCSGWorkerClient,
} from './CSGWorker';
export { createCSGWorkerSource } from './CSGWorkerRuntime';
export type { IcosahedronGeometryOptions } from './IcosahedronGeometry';
