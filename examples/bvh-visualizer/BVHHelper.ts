import { BasicMaterial, CartesianTransform3D, Entity, Geometry3D, Mesh3D } from '@haiyue/engine';
import type { HaiyueEngine } from '@haiyue/engine';
import type { RaycastBVHSnapshot, RaycastBVHTrace } from '@haiyue/engine/experimental/diagnostics';
import { vec3 } from 'wgpu-matrix';

type Scene = ReturnType<HaiyueEngine['createScene']>;
type Node = RaycastBVHSnapshot['nodes'][number];
type Color = readonly [number, number, number, number];
export const COLORS = { idle: [0.18, 0.32, 0.42, 1], branch: [1, 0.62, 0.12, 1], leaf: [0.55, 1, 0.16, 1], rejected: [0.95, 0.27, 0.34, 1], ray: [0.16, 0.85, 1, 1] } as const;

/** Batched thin tubes render in the same depth pass as the mesh, from every viewing angle. */
export class Overlay {
  readonly geometry = new Geometry3D({ positions: new Float32Array(0), cullMode: 'none' });
  readonly entity: Entity;
  constructor(scene: Scene, name: string, color: Color) {
    this.entity = new Entity(name).addComponent(new CartesianTransform3D())
      .addComponent(new Mesh3D(this.geometry, new BasicMaterial({ color, cullMode: 'none' })));
    this.entity.disabled = true;
    scene.add(this.entity);
  }
  setPositions(positions: Float32Array): void {
    this.entity.disabled = positions.length === 0;
    this.geometry.positions = positions;
    this.geometry.markDirty();
  }
  setSegments(segments: number[], radius: number): void { this.setPositions(tubeSegments(segments, radius)); }
}

export function tubeSegments(segments: number[], radius: number): Float32Array {
  const positions: number[] = [];
  for (let offset = 0; offset < segments.length; offset += 6) {
    const a = segments.slice(offset, offset + 3);
    const b = segments.slice(offset + 3, offset + 6);
    const d = vec3.subtract(b, a);
    if (vec3.length(d) < 1e-7) continue;
    vec3.normalize(d, d);
    const u = vec3.mulScalar(vec3.normalize(vec3.cross(d, Math.abs(d[1]!) < 0.9 ? [0, 1, 0] : [1, 0, 0])), radius);
    const v = vec3.cross(d, u);
    const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([su, sv]) =>
      a.map((_, i) => u[i]! * su! + v[i]! * sv!));
    for (let side = 0; side < 4; side++) {
      const c = corners[side]!;
      const next = corners[(side + 1) % 4]!;
      const p0 = a.map((value, i) => value + c[i]!);
      const p1 = a.map((value, i) => value + next[i]!);
      const p2 = b.map((value, i) => value + next[i]!);
      const p3 = b.map((value, i) => value + c[i]!);
      positions.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
    }
  }
  return new Float32Array(positions);
}

function boxEdges(node: Node, output: number[]): void {
  // Corner bit 0 = X, bit 1 = Y, bit 2 = Z; each edge is emitted once.
  for (let corner = 0; corner < 8; corner++) {
    for (let axis = 0; axis < 3; axis++) {
      if (corner & (1 << axis)) continue;
      for (const vertex of [corner, corner | (1 << axis)]) {
        for (let component = 0; component < 3; component++) {
          output.push((vertex & (1 << component) ? node.max : node.min)[component]!);
        }
      }
    }
  }
}

/** One helper for the entire real BVH; nodes are batched by state instead of making thousands of entities. */
export class BVHHelper {
  private readonly idle: Overlay;
  private readonly branches: Overlay;
  private readonly leaves: Overlay;
  private readonly rejected: Overlay;
  private snapshot: RaycastBVHSnapshot;
  private depth = 3;
  private backgroundVisible = true;
  private showRejected = false;
  private lastTrace: RaycastBVHTrace | null = null;
  private lastStep = 0;

  constructor(scene: Scene, snapshot: RaycastBVHSnapshot) {
    this.snapshot = snapshot;
    this.idle = new Overlay(scene, 'BVH unvisited node helpers', COLORS.idle);
    this.branches = new Overlay(scene, 'BVH accepted branch helpers', COLORS.branch);
    this.leaves = new Overlay(scene, 'BVH tested leaf helpers', COLORS.leaf);
    this.rejected = new Overlay(scene, 'BVH rejected node helpers', COLORS.rejected);
    this.updateBackground();
  }
  configure(depth: number, backgroundVisible: boolean, showRejected: boolean): void {
    this.depth = depth;
    this.backgroundVisible = backgroundVisible;
    this.showRejected = showRejected;
    this.updateBackground();
    this.show(this.lastTrace, this.lastStep);
  }
  private updateBackground(): void {
    const edges: number[] = [];
    if (this.backgroundVisible) {
      for (const node of this.snapshot.nodes) if (node.depth === this.depth || node.depth === 0) boxEdges(node, edges);
    }
    this.idle.setSegments(edges, 0.004);
  }
  show(trace: RaycastBVHTrace | null, step: number): Node[] {
    this.lastTrace = trace;
    this.lastStep = step;
    if (trace && trace.snapshot !== this.snapshot) {
      this.snapshot = trace.snapshot;
      this.updateBackground();
    }
    const branchEdges: number[] = [], leafEdges: number[] = [], rejectedEdges: number[] = [];
    const testedLeaves: Node[] = [];
    if (trace) {
      // The mesh broad-phase may reject before any BVH node is visited.
      if (!trace.broadPhaseHit && this.showRejected && this.snapshot.nodes[0]) boxEdges(this.snapshot.nodes[0], rejectedEdges);
      for (const visit of trace.steps.slice(0, step)) {
        const node = this.snapshot.nodes[visit.nodeId]!;
        if (!visit.accepted) {
          if (this.showRejected) boxEdges(node, rejectedEdges);
        } else if (node.left === null && node.right === null) {
          testedLeaves.push(node);
          boxEdges(node, leafEdges);
        } else boxEdges(node, branchEdges);
      }
    }
    this.branches.setSegments(branchEdges, 0.011);
    this.leaves.setSegments(leafEdges, 0.014);
    this.rejected.setSegments(rejectedEdges, 0.006);
    return testedLeaves;
  }
}

/** Every triangle of every accepted leaf is tested, even when it does not itself intersect the ray. */
export function testedTrianglePositions(geometry: Geometry3D, snapshot: RaycastBVHSnapshot, leaves: readonly Node[]): Float32Array {
  const positions: number[] = [];
  for (const node of leaves) {
    for (let triangle = node.start; triangle < node.end; triangle++) {
      for (let corner = 0; corner < 3; corner++) {
        const vertex = snapshot.triangleIndices[triangle * 3 + corner]!;
        for (let axis = 0; axis < 3; axis++) {
          // A tiny surface offset avoids z-fighting. This overlay is excluded from all queries.
          positions.push(geometry.positions[vertex * 3 + axis]! + (geometry.normals?.[vertex * 3 + axis] ?? 0) * 0.006);
        }
      }
    }
  }
  return new Float32Array(positions);
}
