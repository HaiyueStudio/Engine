import { evaluateGeometry } from './geometry.js';
import { VectorResourceOwner } from './resource-owner.js';
import type { RuntimeDrawOperation, RuntimeDrawPlan, RuntimeGeometryResult, RuntimeNode, RuntimeVectorDocument, VectorRuntimeStats } from './runtime-types.js';

export interface VectorEvaluateOptions {
  readonly time: number;
  readonly width?: number;
  readonly height?: number;
  readonly loop?: boolean;
  readonly mix?: { readonly opacity?: number; readonly transform?: readonly [number, number, number, number, number, number] };
}

export class VectorVisualRuntime {
  private readonly geometryCache = new Map<string, RuntimeGeometryResult>();
  private readonly paintCache = new Set<string>();
  private readonly targets = new VectorResourceOwner<unknown>();
  private generation = 0;
  private isDisposed = false;

  constructor(readonly document: RuntimeVectorDocument) {}

  evaluate(options: VectorEvaluateOptions): RuntimeDrawPlan {
    this.assertLive();
    const width = options.width ?? this.document.width;
    const height = options.height ?? this.document.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('E_VECTOR_VIEWPORT');
    const time = normalizeTime(options.time, this.document.duration ?? 0, options.loop ?? false);
    const nodeGeometry = new Map<string, readonly RuntimeGeometryResult[]>();
    const nodeTransforms = new Map<string, readonly [number, number, number, number, number, number]>();
    for (const node of this.document.nodes) {
      nodeGeometry.set(node.id, node.geometries.map((geometry, index) => this.getGeometry(node, index, geometry, time)));
      nodeTransforms.set(node.id, multiplyTransform(node.transform ?? IDENTITY, options.mix?.transform ?? IDENTITY));
    }

    const hasSolo = this.document.nodes.some(node => node.solo && node.visible !== false);
    const visible = this.document.nodes.filter(node => node.visible !== false && (!hasSolo || node.solo));
    const sorted = [...visible].sort((a, b) => a.drawOrder - b.drawOrder || a.id.localeCompare(b.id));
    const operations: RuntimeDrawOperation[] = [];
    for (const node of sorted) {
      const transform = multiplyTransform(node.transform ?? IDENTITY, options.mix?.transform ?? IDENTITY);
      const opacity = (node.opacity ?? 1) * (options.mix?.opacity ?? 1);
      const geometries = nodeGeometry.get(node.id)!;
      for (let geometryIndex = 0; geometryIndex < geometries.length; geometryIndex++) {
        if (node.paints.length === 0 && geometries[geometryIndex]!.image) {
          operations.push(Object.freeze({ nodeId: node.id, geometryIndex, paintIndex: -1, drawOrder: node.drawOrder, opacity, transform, geometry: geometries[geometryIndex]!, paint: IMAGE_PAINT, clips: Object.freeze([...(node.clips ?? [])]), effectGroups: Object.freeze([...(node.effectGroups ?? [])]) }));
        }
        for (let paintIndex = 0; paintIndex < node.paints.length; paintIndex++) {
          const paint = node.paints[paintIndex]!;
          if (paint.visible === false) continue;
          this.paintCache.add(`${node.id}:${paintIndex}:${stablePaintKey(paint)}`);
          operations.push(Object.freeze({
            nodeId: node.id,
            geometryIndex,
            paintIndex,
            drawOrder: node.drawOrder,
            opacity: opacity * (paint.opacity ?? 1),
            transform,
            geometry: geometries[geometryIndex]!,
            paint,
            clips: Object.freeze([...(node.clips ?? [])]),
            effectGroups: Object.freeze([...(node.effectGroups ?? [])]),
          }));
        }
      }
    }
    return Object.freeze({ time, width, height, deviceGeneration: this.generation, operations: Object.freeze(operations), clips: new Map(this.document.clips.map(clip => [clip.id, clip])), resources: new Map(this.document.resources.map(resource => [resource.id, resource])), nodeGeometry, nodeTransforms });
  }

  acquireTarget<T>(key: string, pixels: number, create: () => T, destroy: (value: T) => void): T {
    this.assertLive();
    return this.targets.acquire(key, pixels, create, value => destroy(value as T)) as T;
  }

  retireTarget(key: string): void { this.targets.retire(key); }
  afterSubmit(): void { this.targets.flushRetired(); }

  notifyDeviceLost(): void {
    if (this.isDisposed) return;
    this.targets.retireAll();
    this.targets.flushRetired();
    this.geometryCache.clear();
    this.paintCache.clear();
  }

  recoverDevice(deviceGeneration?: number): void {
    this.assertLive();
    this.notifyDeviceLost();
    this.generation = deviceGeneration ?? this.generation + 1;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.geometryCache.clear();
    this.paintCache.clear();
    this.targets.dispose();
  }

  get stats(): VectorRuntimeStats {
    return Object.freeze({ geometryEntries: this.geometryCache.size, paintEntries: this.paintCache.size, targetEntries: this.targets.size, retiredEntries: this.targets.retiredSize, deviceGeneration: this.generation, disposed: this.isDisposed });
  }

  private getGeometry(node: RuntimeNode, index: number, geometry: RuntimeNode['geometries'][number], time: number): RuntimeGeometryResult {
    const animated = geometry.kind === 'path' && (geometry.frames?.length ?? 0) > 0;
    const key = `${node.id}:${index}:${animated ? time : 'static'}`;
    let result = this.geometryCache.get(key);
    if (!result) { result = freezeGeometry(evaluateGeometry(geometry, time)); this.geometryCache.set(key, result); }
    return result;
  }

  private assertLive(): void { if (this.isDisposed) throw new Error('E_VECTOR_RUNTIME_DISPOSED'); }
}

const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0] as const);
const IMAGE_PAINT = Object.freeze({ kind: 'fill', source: Object.freeze({ kind: 'solid', color: Object.freeze([1, 1, 1, 1] as const) }) } as const);
function normalizeTime(time: number, duration: number, loop: boolean): number { if (!Number.isFinite(time)) throw new Error('E_VECTOR_TIME'); if (!loop || duration <= 0) return Math.max(0, Math.min(duration || time, time)); return ((time % duration) + duration) % duration; }
function multiplyTransform(a: readonly [number, number, number, number, number, number], b: readonly [number, number, number, number, number, number]): readonly [number, number, number, number, number, number] { return Object.freeze([a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]); }
function stablePaintKey(value: unknown): string { return JSON.stringify(value); }
function freezeGeometry(value: RuntimeGeometryResult): RuntimeGeometryResult { for (const contour of value.contours) { Object.freeze(contour.points); Object.freeze(contour); } Object.freeze(value.contours); return Object.freeze(value); }
