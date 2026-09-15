import type { Geometry3D } from '@haiyue/engine';
import type { RaycastBVHSnapshot } from '@haiyue/engine/experimental/diagnostics';
import { vec3 } from 'wgpu-matrix';

type Node = RaycastBVHSnapshot['nodes'][number];

/** Enlarges the actual source triangles in the latest accepted leaf, projected onto its first face plane. */
export function drawLeafPreview(canvas: HTMLCanvasElement, geometry: Geometry3D, snapshot: RaycastBVHSnapshot, leaf?: Node): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#102131';
  ctx.fillRect(0, 0, width, height);
  if (!leaf) {
    ctx.fillStyle = '#839bb0'; ctx.font = '22px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('尚未到达叶子节点', width / 2, height / 2);
    return;
  }
  const vertices: number[][] = [];
  for (let i = leaf.start * 3; i < leaf.end * 3; i++) {
    const offset = snapshot.triangleIndices[i]! * 3;
    vertices.push(Array.from(geometry.positions.subarray(offset, offset + 3)));
  }
  let tangent = vec3.create(1, 0, 0), normal = vec3.create(0, 0, 1);
  for (let i = 0; i < vertices.length; i += 3) {
    const edge = vec3.subtract(vertices[i + 1]!, vertices[i]!);
    const cross = vec3.cross(edge, vec3.subtract(vertices[i + 2]!, vertices[i]!));
    if (vec3.length(cross) < 1e-10) continue;
    tangent = vec3.normalize(edge); normal = vec3.normalize(cross); break;
  }
  const bitangent = vec3.cross(normal, tangent);
  const projected = vertices.map(vertex => {
    const offset = vec3.subtract(vertex, vertices[0]!);
    return [vec3.dot(offset, tangent), vec3.dot(offset, bitangent)] as const;
  });
  const xs = projected.map(p => p[0]), ys = projected.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((width - 48) / Math.max(maxX - minX, 1e-6), (height - 48) / Math.max(maxY - minY, 1e-6));
  ctx.fillStyle = '#a4ff494d'; ctx.strokeStyle = '#acff63'; ctx.lineWidth = 2;
  for (let i = 0; i < projected.length; i += 3) {
    ctx.beginPath();
    for (let j = 0; j < 3; j++) {
      const p = projected[i + j]!;
      const x = width / 2 + (p[0] - (minX + maxX) / 2) * scale;
      const y = height / 2 - (p[1] - (minY + maxY) / 2) * scale;
      if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
}
