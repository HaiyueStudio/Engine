import { EngineError, EngineErrorCode } from '../core/EngineError';
import { requiredNumberAt, requiredVec3Array } from '../math/arrayAccess';

let _geoIdCounter = 0;

export interface CustomAttribute {
  /** Name for debugging */
  name: string;
  /** Vertex shader location */
  location: number;
  /** WebGPU vertex format */
  format: GPUVertexFormat;
  /** Number of components per vertex element */
  itemSize: number;
  data: Float32Array;
}

export interface InstanceAttribute {
  name: string;
  /** Vertex shader location (should follow after vertex attributes) */
  location: number;
  format: GPUVertexFormat;
  itemSize: number;
  data: Float32Array;
  instanceCount: number;
}

export interface MorphTarget3D {
  positions?: Float32Array;
  normals?: Float32Array;
}

export interface Skinning3DOptions {
  joints: Float32Array;
  weights: Float32Array;
  jointMatrices: Float32Array;
}

export interface Skinning3D {
  joints: Float32Array;
  weights: Float32Array;
  jointMatrices: Float32Array;
  version: number;
}

/** Controls whether Render3D may derive a culling bound from CPU positions. */
export type Geometry3DBoundsMode = 'static' | 'dynamic' | 'manual';

/** A caller-supplied conservative local-space bound. */
export interface Geometry3DLocalBounds {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

/** A glTF-style texture-coordinate semantic and its per-vertex data. */
export interface Geometry3DTextureCoordinateSet {
  /** Non-negative semantic index (`2` means `TEXCOORD_2`). */
  readonly set: number;
  readonly data: Float32Array;
}

/** Number of physical UV inputs exposed by the current 3D shader contract. */
export const GEOMETRY3D_UV_CHANNEL_CAPACITY = 2;

export interface Geometry3DOptions {
  positions: Float32Array;
  normals?: Float32Array;
  /** Texture-coordinate data keyed by glTF-style semantic set. */
  textureCoordinates?: readonly Geometry3DTextureCoordinateSet[];
  /** Physical shader channel -> semantic-set mapping. */
  textureCoordinateLayout?: readonly number[];
  indices?: Uint16Array | Uint32Array;
  topology?: GPUPrimitiveTopology;
  cullMode?: GPUCullMode;
  frontFace?: GPUFrontFace;
  customAttributes?: CustomAttribute[];
  instanceAttributes?: InstanceAttribute[];
  instanceCount?: number;
  morphTargets?: MorphTarget3D[];
  morphWeights?: number[] | Float32Array;
  morphUseGpu?: boolean;
  skinning?: Skinning3DOptions;
  /**
   * `static` derives bounds from positions, `dynamic` disables culling unless
   * localBounds is supplied, and `manual` always uses localBounds.
   * GPU morph and skinned geometry default to `dynamic`.
   */
  boundsMode?: Geometry3DBoundsMode;
  /** Conservative local-space bounds for dynamic/manual geometry. */
  localBounds?: Geometry3DLocalBounds | null;
}

export class Geometry3D {
  readonly id: number = ++_geoIdCounter;
  version = 0;

  positions: Float32Array;
  normals: Float32Array | null;
  /** All texture-coordinate sets keyed by their semantic index. */
  readonly textureCoordinates: ReadonlyMap<number, Float32Array>;
  /** Physical shader channel -> semantic-set mapping. */
  readonly textureCoordinateLayout: readonly number[];
  /** Stable cache/pipeline discriminator for the physical semantic layout. */
  readonly textureCoordinateLayoutKey: string;
  indices: Uint16Array | Uint32Array | null;
  topology: GPUPrimitiveTopology | null;
  cullMode: GPUCullMode | null;
  frontFace: GPUFrontFace | null;
  customAttributes: Map<string, CustomAttribute>;
  instanceAttributes: Map<string, InstanceAttribute>;
  instanceCount: number;
  morphTargets: MorphTarget3D[];
  morphWeights: Float32Array;
  morphUseGpu: boolean;
  morphBasePositions: Float32Array | null;
  morphBaseNormals: Float32Array | null;
  morphVersion = 0;
  skinning: Skinning3D | null;
  boundsMode: Geometry3DBoundsMode;
  /** Changes independently from vertex-buffer content versions. */
  boundsVersion = 0;

  private readonly _bbox = {
    min: new Float32Array(3),
    max: new Float32Array(3),
  };
  private _bboxDirty = true;
  private _localBounds: Geometry3DLocalBounds | null;
  private _boundsModeExplicit: boolean;
  private readonly _boundsChangeListeners = new Set<(geometry: Geometry3D) => void>();

  constructor(options: Geometry3DOptions) {
    validateGeometry3DOptions(options);
    const textureCoordinates = createTextureCoordinateMap(options);
    const textureCoordinateLayout = createTextureCoordinateLayout(options, textureCoordinates);
    this.positions = options.positions;
    this.normals = options.normals ?? null;
    this.textureCoordinates = textureCoordinates;
    this.textureCoordinateLayout = textureCoordinateLayout;
    this.textureCoordinateLayoutKey = textureCoordinateLayout.length === 0
      ? 'none'
      : textureCoordinateLayout.map((set, channel) => `${channel}=TEXCOORD_${set}`).join('|');
    this.indices = options.indices ?? null;
    this.topology = options.topology ?? null;
    this.cullMode = options.cullMode ?? null;
    this.frontFace = options.frontFace ?? null;
    this.instanceCount = options.instanceCount ?? 1;
    this.morphTargets = options.morphTargets ?? [];
    this.morphWeights = new Float32Array(options.morphWeights ?? new Array(this.morphTargets.length).fill(0));
    this.morphUseGpu = options.morphUseGpu ?? true;
    this.morphBasePositions = this.morphTargets.length > 0 ? Float32Array.from(this.positions) : null;
    this.morphBaseNormals = this.morphTargets.length > 0 && this.normals ? Float32Array.from(this.normals) : null;
    this.skinning = options.skinning ? {
      joints: options.skinning.joints,
      weights: options.skinning.weights,
      jointMatrices: options.skinning.jointMatrices,
      version: 0,
    } : null;
    this._boundsModeExplicit = options.boundsMode !== undefined;
    this.boundsMode = options.boundsMode ?? inferBoundsMode(this.morphTargets, this.morphUseGpu, this.skinning);
    this._localBounds = copyLocalBounds(options.localBounds ?? null);
    validateBoundsContract(this.boundsMode, this._localBounds);

    this.customAttributes = new Map();
    if (options.customAttributes) {
      for (const attr of options.customAttributes) {
        this.customAttributes.set(attr.name, attr);
      }
    }

    this.instanceAttributes = new Map();
    if (options.instanceAttributes) {
      for (const attr of options.instanceAttributes) {
        this.instanceAttributes.set(attr.name, attr);
      }
    }
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get indexCount(): number {
    return this.indices?.length ?? 0;
  }

  getTextureCoordinates(set: number): Float32Array | null {
    return this.textureCoordinates.get(set) ?? null;
  }

  getTextureCoordinatesForChannel(channel: number): Float32Array | null {
    const set = this.textureCoordinateLayout[channel];
    return set === undefined ? null : this.textureCoordinates.get(set) ?? null;
  }

  markDirty(): void {
    this.version++;
    this._bboxDirty = true;
    this._notifyBoundsChanged();
  }

  addBoundsChangeListener(listener: (geometry: Geometry3D) => void): void {
    this._boundsChangeListeners.add(listener);
  }

  removeBoundsChangeListener(listener: (geometry: Geometry3D) => void): void {
    this._boundsChangeListeners.delete(listener);
  }

  get localBounds(): Geometry3DLocalBounds | null {
    return this._localBounds;
  }

  /** Selects an explicit bounds policy. Manual mode requires localBounds. */
  setBoundsMode(mode: Geometry3DBoundsMode): this {
    validateBoundsContract(mode, this._localBounds);
    if (this.boundsMode !== mode) {
      this.boundsMode = mode;
      this.boundsVersion++;
      this._notifyBoundsChanged();
    }
    this._boundsModeExplicit = true;
    return this;
  }

  /** Updates conservative local bounds used by dynamic/manual policies. */
  setLocalBounds(bounds: Geometry3DLocalBounds | null): this {
    const next = copyLocalBounds(bounds);
    validateBoundsContract(this.boundsMode, next);
    if (sameLocalBounds(this._localBounds, next)) return this;
    this._localBounds = next;
    this.boundsVersion++;
    this._notifyBoundsChanged();
    return this;
  }

  setMorphTargets(targets: MorphTarget3D[], weights?: number[] | Float32Array): void {
    this.morphTargets = targets;
    this.morphWeights = new Float32Array(weights ?? new Array(targets.length).fill(0));
    this.morphBasePositions = targets.length > 0 ? Float32Array.from(this.positions) : null;
    this.morphBaseNormals = targets.length > 0 && this.normals ? Float32Array.from(this.normals) : null;
    this.morphVersion++;
    this._bboxDirty = true;
    this._refreshAutomaticBoundsMode();
    this._notifyBoundsChanged();
  }

  setMorphWeights(weights: number[] | Float32Array): void {
    if (this.morphWeights.length === weights.length) {
      this.morphWeights.set(weights);
    } else {
      this.morphWeights = new Float32Array(weights);
    }
    this.morphVersion++;
    this._bboxDirty = true;
    this._notifyBoundsChanged();
  }

  get hasMorphTargets(): boolean {
    return this.morphTargets.length > 0;
  }

  setMorphUseGpu(useGpu: boolean): void {
    if (this.morphUseGpu === useGpu) return;
    this.morphUseGpu = useGpu;
    if (useGpu) {
      if (this.morphBasePositions) this.positions.set(this.morphBasePositions);
      if (this.normals && this.morphBaseNormals) this.normals.set(this.morphBaseNormals);
      this.version++;
    }
    this.morphVersion++;
    this._bboxDirty = true;
    this._refreshAutomaticBoundsMode();
    this._notifyBoundsChanged();
  }

  setSkinning(skinning: Skinning3DOptions | null): void {
    this.skinning = skinning ? {
      joints: skinning.joints,
      weights: skinning.weights,
      jointMatrices: skinning.jointMatrices,
      version: 0,
    } : null;
    this.version++;
    this._refreshAutomaticBoundsMode();
    this._notifyBoundsChanged();
  }

  updateSkinningMatrices(jointMatrices: Float32Array): void {
    if (!this.skinning) return;
    if (this.skinning.jointMatrices.length === jointMatrices.length) {
      this.skinning.jointMatrices.set(jointMatrices);
    } else {
      this.skinning.jointMatrices = new Float32Array(jointMatrices);
      this.version++;
    }
    this.skinning.version++;
  }

  /** Lazily computed local-space AABB. */
  getBoundingBox(): { min: Float32Array; max: Float32Array } {
    if (!this._bboxDirty) return this._bbox;
    const p = this.positions;
    validateGeometry3DPositionShape(p);
    const min = requiredVec3Array(this._bbox.min, 'Geometry3D bounding-box minimum');
    const max = requiredVec3Array(this._bbox.max, 'Geometry3D bounding-box maximum');
    if (p.length === 0) {
      min.fill(0);
      max.fill(0);
      this._bboxDirty = false;
      return this._bbox;
    }
    min.fill(Infinity);
    max.fill(-Infinity);
    for (let i = 0; i < p.length; i += 3) {
      const x = requiredNumberAt(p, i, 'Geometry3D positions');
      const y = requiredNumberAt(p, i + 1, 'Geometry3D positions');
      const z = requiredNumberAt(p, i + 2, 'Geometry3D positions');
      requireFiniteGeometry3DPosition(x, i);
      requireFiniteGeometry3DPosition(y, i + 1);
      requireFiniteGeometry3DPosition(z, i + 2);
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }
    this._bboxDirty = false;
    return this._bbox;
  }

  private _refreshAutomaticBoundsMode(): void {
    if (this._boundsModeExplicit) return;
    const next = inferBoundsMode(this.morphTargets, this.morphUseGpu, this.skinning);
    if (next === this.boundsMode) return;
    this.boundsMode = next;
    this.boundsVersion++;
  }

  private _notifyBoundsChanged(): void {
    for (const listener of this._boundsChangeListeners) listener(this);
  }
}

function inferBoundsMode(
  morphTargets: readonly MorphTarget3D[],
  morphUseGpu: boolean,
  skinning: Skinning3D | null,
): Geometry3DBoundsMode {
  return skinning || (morphUseGpu && morphTargets.length > 0) ? 'dynamic' : 'static';
}

function copyLocalBounds(bounds: Geometry3DLocalBounds | null): Geometry3DLocalBounds | null {
  if (!bounds) return null;
  const [x, y, z] = bounds.center;
  if (![x, y, z, bounds.radius].every(Number.isFinite) || bounds.radius < 0) {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      'Geometry3D localBounds must contain a finite center and a non-negative finite radius.',
      { docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER' },
    );
  }
  return Object.freeze({ center: Object.freeze([x, y, z] as [number, number, number]), radius: bounds.radius });
}

function sameLocalBounds(a: Geometry3DLocalBounds | null, b: Geometry3DLocalBounds | null): boolean {
  return a === b || Boolean(a && b
    && a.radius === b.radius
    && a.center[0] === b.center[0]
    && a.center[1] === b.center[1]
    && a.center[2] === b.center[2]);
}

function validateBoundsContract(mode: Geometry3DBoundsMode, bounds: Geometry3DLocalBounds | null): void {
  if (mode !== 'static' && mode !== 'dynamic' && mode !== 'manual') {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      `Unknown Geometry3D boundsMode "${String(mode)}".`,
      { docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER' },
    );
  }
  if (mode === 'manual' && !bounds) {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      'Geometry3D manual boundsMode requires localBounds.',
      { docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER' },
    );
  }
}

function validateGeometry3DOptions(options: Geometry3DOptions): void {
  validateGeometry3DPositions(options.positions);
  const vertexCount = options.positions.length / 3;
  if (options.normals && (!(options.normals instanceof Float32Array) || options.normals.length !== options.positions.length)) {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      `Geometry3D normals length must match positions length (${options.positions.length}); received ${options.normals.length}.`,
      {
        hint: 'Provide one normal per vertex, or omit normals to let renderers use fallback normals.',
        docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
      },
    );
  }
  const seenTextureCoordinateSets = new Set<number>();
  for (const entry of options.textureCoordinates ?? []) {
    if (!Number.isInteger(entry.set) || entry.set < 0) {
      throw new EngineError(
        EngineErrorCode.GeometryInvalidParameter,
        `Geometry3D texture-coordinate semantic must be a non-negative integer; received ${entry.set}.`,
        { docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER' },
      );
    }
    if (seenTextureCoordinateSets.has(entry.set)) {
      throw new EngineError(
        EngineErrorCode.GeometryInvalidParameter,
        `Geometry3D textureCoordinates contains duplicate TEXCOORD_${entry.set}.`,
        { docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER' },
      );
    }
    seenTextureCoordinateSets.add(entry.set);
    if (!(entry.data instanceof Float32Array) || entry.data.length !== vertexCount * 2) {
      throw new EngineError(
        EngineErrorCode.GeometryInvalidParameter,
        `Geometry3D TEXCOORD_${entry.set} length must be vertexCount * 2 (${vertexCount * 2}); received ${entry.data.length}.`,
        { docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER' },
      );
    }
  }
  if ((options.textureCoordinateLayout?.length ?? 0) > GEOMETRY3D_UV_CHANNEL_CAPACITY) {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      `Geometry3D textureCoordinateLayout exceeds the ${GEOMETRY3D_UV_CHANNEL_CAPACITY}-channel shader capacity.`,
      { docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER' },
    );
  }
  const availableSets = new Set(seenTextureCoordinateSets);
  const seenLayoutSets = new Set<number>();
  for (const set of options.textureCoordinateLayout ?? []) {
    if (!Number.isInteger(set) || set < 0 || !availableSets.has(set) || seenLayoutSets.has(set)) {
      throw new EngineError(
        EngineErrorCode.GeometryInvalidParameter,
        `Geometry3D textureCoordinateLayout must contain unique available semantic sets; TEXCOORD_${set} is invalid.`,
        { docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER' },
      );
    }
    seenLayoutSets.add(set);
  }
  if (options.indices && !(options.indices instanceof Uint16Array) && !(options.indices instanceof Uint32Array)) {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      'Geometry3D indices must be Uint16Array or Uint32Array.',
      {
        hint: 'Use Uint16Array for <= 65535 vertices or Uint32Array for larger meshes.',
        docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
      },
    );
  }
  if (options.indices) {
    for (let i = 0; i < options.indices.length; i++) {
      const index = requiredNumberAt(options.indices, i, 'Geometry3D indices');
      if (index >= vertexCount) {
        throw new EngineError(
          EngineErrorCode.GeometryInvalidParameter,
          `Geometry3D index ${index} at offset ${i} exceeds vertexCount ${vertexCount}.`,
          {
            hint: 'Ensure every index references an existing vertex.',
            docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
          },
        );
      }
    }
  }
}

function createTextureCoordinateMap(options: Geometry3DOptions): ReadonlyMap<number, Float32Array> {
  const coordinates = new Map<number, Float32Array>();
  for (const entry of options.textureCoordinates ?? []) coordinates.set(entry.set, entry.data);
  return coordinates;
}

function createTextureCoordinateLayout(
  options: Geometry3DOptions,
  coordinates: ReadonlyMap<number, Float32Array>,
): readonly number[] {
  if (options.textureCoordinateLayout) return Object.freeze([...options.textureCoordinateLayout]);
  const layout: number[] = [];
  if (coordinates.has(0)) layout.push(0);
  if (coordinates.has(1)) layout.push(1);
  return Object.freeze(layout);
}

function validateGeometry3DPositions(positions: Float32Array): void {
  validateGeometry3DPositionShape(positions);
  for (let i = 0; i < positions.length; i++) {
    requireFiniteGeometry3DPosition(
      requiredNumberAt(positions, i, 'Geometry3D positions'),
      i,
    );
  }
}

function validateGeometry3DPositionShape(positions: Float32Array): void {
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0) {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      'Geometry3D positions must be a Float32Array with complete xyz triplets.',
      {
        hint: 'Pass positions as Float32Array([x, y, z, ...]) with length divisible by 3; an empty array represents empty geometry.',
        docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
      },
    );
  }
}

function requireFiniteGeometry3DPosition(value: number, index: number): void {
  if (!Number.isFinite(value)) {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      `Geometry3D position at offset ${index} must be finite; received ${String(value)}.`,
      {
        hint: 'Replace NaN or infinite position values before creating or marking geometry dirty.',
        docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
      },
    );
  }
}
