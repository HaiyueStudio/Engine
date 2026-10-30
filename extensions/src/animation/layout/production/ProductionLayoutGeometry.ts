import type {ProductionLayoutNode} from './types.js';

export type LayoutAffine = readonly [number, number, number, number, number, number];
type Rect = readonly [number, number, number, number];
type Point = readonly [number, number];
export const identityLayoutTransform: LayoutAffine = Object.freeze([1, 0, 0, 1, 0, 0]);

export class ProductionLayoutGeometryError extends Error {
  override readonly name = 'ProductionLayoutGeometryError';
  readonly code = 'E_HYA_RUNTIME_LAYOUT';
  constructor(readonly path: string, message: string) {super(`${message} (${path})`);}
}
function finite(values: readonly number[], path: string): void {
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value)))
    throw new ProductionLayoutGeometryError(path, 'layout affine produced non-finite geometry');
}
/** Copy once at owner creation. The original solver continues in fitted layout coordinates. */
export function snapshotLayoutTransform(value: LayoutAffine | undefined, path = '$.instances.transform'): LayoutAffine {
  if (value === undefined) return identityLayoutTransform;
  if (!Array.isArray(value) || value.length !== 6)
    throw new ProductionLayoutGeometryError(path, 'expected six finite affine coefficients');
  finite(value, path);
  if (value.every((v, i) => v === identityLayoutTransform[i])) return identityLayoutTransform;
  return Object.freeze([...value]) as LayoutAffine;
}
/** Column-vector composition: the left matrix acts after the right matrix. */
export function multiplyLayoutTransforms(left: LayoutAffine, right: LayoutAffine): LayoutAffine {
  if (left === identityLayoutTransform) return right;
  const [a,b,c,d,x,y] = left, [e,f,g,h,u,v] = right;
  const result: LayoutAffine = [a*e+c*f, b*e+d*f, a*g+c*h, b*g+d*h, a*u+c*v+x, b*u+d*v+y];
  finite(result, '$.layout.transform');
  return Object.freeze(result);
}
export function layoutPoint(matrix: LayoutAffine, point: Point): Point {
  const result: Point = [matrix[0]*point[0]+matrix[2]*point[1]+matrix[4], matrix[1]*point[0]+matrix[3]*point[1]+matrix[5]];
  finite(result, '$.layout.point');
  return Object.freeze(result);
}
/** A collapsed root paints no area and cannot own a point hit; it is not a format error. */
export function layoutLocalPoint(matrix: LayoutAffine | undefined, point: Point): Point | undefined {
  if (!matrix) return point;
  // Normalize the linear part before inversion to avoid an overflowing determinant.
  const scale = Math.max(Math.abs(matrix[0]),Math.abs(matrix[1]),Math.abs(matrix[2]),Math.abs(matrix[3]));
  if (!scale) return undefined;
  const a=matrix[0]/scale,b=matrix[1]/scale,c=matrix[2]/scale,d=matrix[3]/scale,det=a*d-b*c;
  if (!det) return undefined;
  const x=(point[0]-matrix[4])/scale,y=(point[1]-matrix[5])/scale;
  const result: Point = [(d*x-c*y)/det, (a*y-b*x)/det];
  return result.every(Number.isFinite) ? Object.freeze(result) : undefined;
}
/** Axis-aligned enclosure for semantic/native host APIs; never used as a rotated hit shape. */
export function layoutRectBounds(rect: Rect, matrix?: LayoutAffine): Rect {
  if (!matrix) return rect;
  const points = [[rect[0],rect[1]],[rect[0]+rect[2],rect[1]],[rect[0],rect[1]+rect[3]],[rect[0]+rect[2],rect[1]+rect[3]]]
    .map(p => layoutPoint(matrix, p as unknown as Point));
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]),x=Math.min(...xs),y=Math.min(...ys);
  const result: Rect=[x,y,Math.max(...xs)-x,Math.max(...ys)-y];
  finite(result, '$.layout.bounds');
  return Object.freeze(result);
}
export function layoutNodeContains(node: Pick<ProductionLayoutNode,'rect'|'clip'|'clipShapes'|'transform'>, point: Point): boolean {
  const local=layoutLocalPoint(node.transform, point);
  if (!local || !contains(node.rect,local) || node.clip && !contains(node.clip,local)) return false;
  return !(node.clipShapes ?? []).some(shape=>!roundedContains(shape.rect,shape.radii,local));
}
function contains(rect: Rect, point: Point): boolean {
  return point[0]>=rect[0] && point[1]>=rect[1] && point[0]<=rect[0]+rect[2] && point[1]<=rect[1]+rect[3];
}
function roundedContains(rect: Rect, radii: Rect, point: Point): boolean {
  if (!contains(rect,point)) return false;
  const x=point[0]-rect[0],y=point[1]-rect[1],right=x>rect[2]/2,bottom=y>rect[3]/2;
  const radius=Math.max(0,Math.min(radii[bottom?(right?2:3):(right?1:0)],rect[2]/2,rect[3]/2));
  const dx=right?rect[2]-x:x,dy=bottom?rect[3]-y:y;
  return dx>=radius || dy>=radius || (dx-radius)**2+(dy-radius)**2<=radius**2;
}
