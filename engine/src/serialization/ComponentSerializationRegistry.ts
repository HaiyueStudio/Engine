import { AmbientLight } from '../lighting/AmbientLight';
import { BasisTransform3D } from '../components/BasisTransform3D';
import { Camera2D } from '../components/Camera2D';
import { Camera3D } from '../components/Camera3D';
import { CartesianTransform3D } from '../components/CartesianTransform3D';
import { ClippingPlanes, MAX_CLIPPING_PLANES, type ClippingPlane } from '../components/ClippingPlanes';
import { isColorValue, toColorSRGB } from '../color/ColorLike';
import { Component } from '../ecs/Component';
import { DataComponent } from '../components/DataComponent';
import { DirectionalLight } from '../lighting/DirectionalLight';
import { EnvironmentLight } from '../lighting/EnvironmentLight';
import { Fog } from '../lighting/Fog';
import { Entity } from '../ecs/Entity';
import { Geometry2D } from '../geometry/Geometry2D';
import type { Geometry3D } from '../geometry/Geometry3D';
import { KeyboardComponent } from '../components/KeyboardComponent';
import type { Material } from '../material/Material';
import { Material2D } from '../material/Material2D';
import { Mesh2D } from '../components/Mesh2D';
import { Mesh3D } from '../components/Mesh3D';
import { MeshHelper } from '../components/MeshHelper';
import { PlanarMirror } from '../components/PlanarMirror';
import { Physics2DBody } from '../physics/Physics2DBody';
import { Physics2DJoint } from '../physics/Physics2DJoint';
import { Physics3DBody } from '../physics/Physics3DBody';
import { Physics3DBuoyancy } from '../physics/Physics3DBuoyancy';
import { Physics3DGravitySource } from '../physics/Physics3DGravitySource';
import { Physics3DJoint } from '../physics/Physics3DJoint';
import { Physics2DTo3DTransformSync } from '../components/Physics2DTo3DTransformSync';
import { PointLight } from '../lighting/PointLight';
import { ScriptComponent, type ScriptLifecycleName } from '../components/ScriptComponent';
import type { ScriptResource } from '../script/ScriptResource';
import { SphericalTransform3D } from '../components/SphericalTransform3D';
import { Transform2D } from '../components/Transform2D';

export type SerializedVec2 = [number, number];
export type SerializedVec3 = [number, number, number];
export type SerializedColor = [number, number, number, number];
export type SerializedArrayLike = unknown;

export type CoreSerializedComponent = { type: string; [key: string]: unknown };

export interface CoreSerializedEntity {
  name: string;
  disabled: boolean;
  components: CoreSerializedComponent[];
  children: CoreSerializedEntity[];
}

export interface ComponentSerializeContext {
  includeComponent?(component: Component): boolean;
  encodeFloat32Array?(value: Float32Array): SerializedArrayLike;
  encodeIndexArray?(value: Uint16Array | Uint32Array): SerializedArrayLike;
  getGeometryId?(geometry: Geometry3D): number | null | undefined;
  getMaterialId?(material: Material): number | null | undefined;
  getScriptId?(script: ScriptResource): number | null | undefined;
  serializeComponent?(component: Component, context: ComponentSerializeContext): CoreSerializedComponent | null | undefined;
}

export interface ComponentDeserializeContext {
  decodeFloat32Array?(value: SerializedArrayLike): Float32Array;
  decodeIndexArray?(value: SerializedArrayLike, indexType?: 'uint16' | 'uint32' | null): Uint16Array | Uint32Array;
  getGeometry?(id: number): Geometry3D | null | undefined;
  getMaterial?(id: number): Material | null | undefined;
  getScript?(id: number): ScriptResource | null | undefined;
  deserializeComponent?(data: CoreSerializedComponent, context: ComponentDeserializeContext): Component | null | undefined;
}

export interface ComponentSerializer<T extends Component = Component> {
  type: string;
  ctor: new (...args: never[]) => T;
  serialize(component: T, context: ComponentSerializeContext): CoreSerializedComponent | null;
  deserialize(data: CoreSerializedComponent, context: ComponentDeserializeContext): T | null;
}

export class ComponentSerializationRegistry {
  private readonly _serializersByType = new Map<string, ComponentSerializer>();
  private readonly _serializersByCtor = new Map<Function, ComponentSerializer>();

  register<T extends Component>(serializer: ComponentSerializer<T>): this {
    this._serializersByType.set(serializer.type, serializer as ComponentSerializer);
    this._serializersByCtor.set(serializer.ctor, serializer as ComponentSerializer);
    return this;
  }

  unregister(typeOrCtor: string | Function): this {
    if (typeof typeOrCtor === 'string') {
      const serializer = this._serializersByType.get(typeOrCtor);
      if (serializer) this._serializersByCtor.delete(serializer.ctor);
      this._serializersByType.delete(typeOrCtor);
      return this;
    }
    const serializer = this._serializersByCtor.get(typeOrCtor);
    if (serializer) this._serializersByType.delete(serializer.type);
    this._serializersByCtor.delete(typeOrCtor);
    return this;
  }

  serialize(component: Component, context: ComponentSerializeContext = {}): CoreSerializedComponent | null {
    if (context.includeComponent?.(component) === false) return null;
    const custom = context.serializeComponent?.(component, context);
    if (custom !== undefined) return custom;
    const direct = this._serializersByCtor.get(component.constructor);
    if (direct) return direct.serialize(component, context);
    for (const serializer of this._serializersByCtor.values()) {
      if (component instanceof serializer.ctor) return serializer.serialize(component, context);
    }
    return null;
  }

  deserialize(data: CoreSerializedComponent, context: ComponentDeserializeContext = {}): Component | null {
    const custom = context.deserializeComponent?.(data, context);
    if (custom !== undefined) return custom;
    return this._serializersByType.get(String(data.type))?.deserialize(data, context) ?? null;
  }
}

export const coreComponentSerializationRegistry = new ComponentSerializationRegistry();

export function serializeEntityCore(
  entity: Entity,
  context: ComponentSerializeContext = {},
  registry = coreComponentSerializationRegistry,
): CoreSerializedEntity {
  return {
    name: entity.name,
    disabled: entity.disabled,
    components: [...entity.components.values()]
      .map(component => registry.serialize(component, context))
      .filter((component): component is CoreSerializedComponent => component !== null),
    children: entity.children.map(child => serializeEntityCore(child, context, registry)),
  };
}

export function deserializeEntityCore(
  data: CoreSerializedEntity,
  context: ComponentDeserializeContext = {},
  registry = coreComponentSerializationRegistry,
): Entity {
  const entity = new Entity(data.name || 'Untitled Entity');
  entity.disabled = Boolean(data.disabled);
  for (const componentData of data.components ?? []) {
    const component = registry.deserialize(componentData, context);
    if (component) entity.addComponent(component);
  }
  for (const childData of data.children ?? []) entity.addChild(deserializeEntityCore(childData, context, registry));
  return entity;
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return value === undefined ? fallback : Boolean(value);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function vec2(value: unknown, fallback: SerializedVec2 = [0, 0]): SerializedVec2 {
  return isNumberArrayLike(value) ? [num(value[0], fallback[0]), num(value[1], fallback[1])] : fallback;
}

function vec3(value: unknown, fallback: SerializedVec3 = [0, 0, 0]): SerializedVec3 {
  return isNumberArrayLike(value) ? [num(value[0], fallback[0]), num(value[1], fallback[1]), num(value[2], fallback[2])] : fallback;
}

function quat(value: unknown, fallback: [number, number, number, number] = [0, 0, 0, 1]): [number, number, number, number] {
  return isNumberArrayLike(value)
    ? [num(value[0], fallback[0]), num(value[1], fallback[1]), num(value[2], fallback[2]), num(value[3], fallback[3])]
    : fallback;
}

function bool3(value: unknown, fallback: [boolean, boolean, boolean] = [false, false, false]): [boolean, boolean, boolean] {
  return isNumberArrayLike(value) || Array.isArray(value)
    ? [bool(value[0], fallback[0]), bool(value[1], fallback[1]), bool(value[2], fallback[2])]
    : fallback;
}

function color(value: unknown, fallback: SerializedColor = [1, 1, 1, 1]): SerializedColor {
  if (isColorValue(value)) {
    const data = toColorSRGB(value);
    return [data.r, data.g, data.b, data.a];
  }
  if (isNumberArrayLike(value)) return [num(value[0], fallback[0]), num(value[1], fallback[1]), num(value[2], fallback[2]), num(value[3], fallback[3])];
  return fallback;
}

function arrayLike(value: ArrayLike<number>): number[] {
  return Array.from(value);
}

function isNumberArrayLike(value: unknown): value is ArrayLike<number> {
  return typeof value === 'object' && value !== null && typeof (value as { length?: unknown }).length === 'number';
}

function clippingPlanes(value: unknown): ClippingPlane[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_CLIPPING_PLANES).flatMap(candidate => {
    const plane = record(candidate);
    const normal = vec3(plane.normal);
    const constant = num(plane.constant, Number.NaN);
    if (!Number.isFinite(constant) || Math.hypot(...normal) <= 1e-8) return [];
    return [{ normal, constant }];
  });
}

function encodeFloat32(value: Float32Array, context: ComponentSerializeContext): SerializedArrayLike {
  return context.encodeFloat32Array?.(value) ?? arrayLike(value);
}

function encodeIndex(value: Uint16Array | Uint32Array, context: ComponentSerializeContext): SerializedArrayLike {
  return context.encodeIndexArray?.(value) ?? arrayLike(value);
}

function decodeFloat32(value: unknown, context: ComponentDeserializeContext): Float32Array {
  if (context.decodeFloat32Array) return context.decodeFloat32Array(value);
  return new Float32Array(Array.isArray(value) ? value.map(item => num(item)) : []);
}

function decodeIndex(value: unknown, indexType: 'uint16' | 'uint32' | null | undefined, context: ComponentDeserializeContext): Uint16Array | Uint32Array | undefined {
  if (value == null) return undefined;
  if (context.decodeIndexArray) return context.decodeIndexArray(value, indexType);
  const values = Array.isArray(value) ? value.map(item => num(item)) : [];
  return indexType === 'uint32' ? new Uint32Array(values) : new Uint16Array(values);
}

function blend2D(value: unknown): 'none' | 'normal' | 'additive' {
  if (value === 'normal' || value === 'alpha') return 'normal';
  if (value === 'additive') return 'additive';
  return 'none';
}

function physicsJointTarget(value: unknown): string | number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function physics3DJointType(value: unknown): 'fixed' | 'spherical' | 'revolute' | 'prismatic' | 'spring' | 'rope' {
  if (
    value === 'spherical'
    || value === 'revolute'
    || value === 'prismatic'
    || value === 'spring'
    || value === 'rope'
  ) return value;
  return 'fixed';
}

function typed<T extends CoreSerializedComponent>(data: CoreSerializedComponent): T {
  return data as T;
}

coreComponentSerializationRegistry
  .register({
    type: 'CartesianTransform3D',
    ctor: CartesianTransform3D,
    serialize: component => ({
      type: 'CartesianTransform3D',
      position: vec3(component.position),
      rotation: vec3(component.rotation),
      scale: vec3(component.scale, [1, 1, 1]),
      anchor: vec3(component.anchor),
    }),
    deserialize: data => new CartesianTransform3D({
      position: vec3(data.position),
      rotation: vec3(data.rotation),
      scale: vec3(data.scale, [1, 1, 1]),
      anchor: vec3(data.anchor),
    }),
  })
  .register({
    type: 'SphericalTransform3D',
    ctor: SphericalTransform3D,
    serialize: component => ({ type: 'SphericalTransform3D', radius: component.radius, theta: component.theta, phi: component.phi, target: vec3(component.target) }),
    deserialize: data => new SphericalTransform3D({ radius: num(data.radius, 10), theta: num(data.theta), phi: num(data.phi, Math.PI / 4), target: vec3(data.target) }),
  })
  .register({
    type: 'BasisTransform3D',
    ctor: BasisTransform3D,
    serialize: component => ({ type: 'BasisTransform3D', coordinates: vec3(component.coordinates), basisX: vec3(component.basisX, [1, 0, 0]), basisY: vec3(component.basisY, [0, 1, 0]), basisZ: vec3(component.basisZ, [0, 0, 1]) }),
    deserialize: data => new BasisTransform3D({ coordinates: vec3(data.coordinates), basisX: vec3(data.basisX, [1, 0, 0]), basisY: vec3(data.basisY, [0, 1, 0]), basisZ: vec3(data.basisZ, [0, 0, 1]) }),
  })
  .register({
    type: 'Transform2D',
    ctor: Transform2D,
    serialize: component => ({ type: 'Transform2D', x: component.x, y: component.y, rotation: component.rotation, scaleX: component.scaleX, scaleY: component.scaleY }),
    deserialize: data => new Transform2D({ x: num(data.x), y: num(data.y), rotation: num(data.rotation), scaleX: num(data.scaleX, 1), scaleY: num(data.scaleY, 1) }),
  })
  .register({
    type: 'Camera3D',
    ctor: Camera3D,
    serialize: component => ({ type: 'Camera3D', projectionType: component.projectionType, fov: component.fov, aspect: component.aspect, near: component.near, far: component.far, orthoLeft: component.orthoLeft, orthoRight: component.orthoRight, orthoTop: component.orthoTop, orthoBottom: component.orthoBottom, reverseZ: component.reverseZ }),
    deserialize: data => {
      const camera = new Camera3D({ type: data.projectionType === 'orthographic' ? 'orthographic' : 'perspective', fov: num(data.fov, Math.PI / 4), aspect: num(data.aspect, 1), near: num(data.near, 0.1), far: num(data.far, 1000), left: num(data.orthoLeft, -1), right: num(data.orthoRight, 1), top: num(data.orthoTop, 1), bottom: num(data.orthoBottom, -1) });
      camera.reverseZ = data.reverseZ === true;
      camera.setDirty();
      return camera;
    },
  })
  .register({
    type: 'Camera2D',
    ctor: Camera2D,
    serialize: component => ({ type: 'Camera2D', width: component.width, height: component.height, near: component.near, far: component.far, zoom: component.zoom, designWidth: component.designWidth, designHeight: component.designHeight, viewportMode: component.viewportMode }),
    deserialize: data => new Camera2D({ width: num(data.width, 800), height: num(data.height, 600), near: num(data.near, -1000), far: num(data.far, 1000), zoom: num(data.zoom, 1), designWidth: num(data.designWidth, num(data.width, 800)), designHeight: num(data.designHeight, num(data.height, 600)), viewportMode: data.viewportMode === 'fit' || data.viewportMode === 'fill' || data.viewportMode === 'fixed' ? data.viewportMode : 'expand' }),
  })
  .register({
    type: 'DataComponent',
    ctor: DataComponent,
    serialize: component => ({ type: 'DataComponent', data: structuredClone(component.value) }),
    deserialize: data => new DataComponent((data.data && typeof data.data === 'object' && !Array.isArray(data.data)) ? data.data as Record<string, never> : {}),
  })
  .register({
    type: 'Mesh3D',
    ctor: Mesh3D,
    serialize: (component, context) => {
      const geometryId = context.getGeometryId?.(component.geometry);
      const materialId = context.getMaterialId?.(component.material);
      return geometryId == null || materialId == null ? null : { type: 'Mesh3D', geometryId, materialId };
    },
    deserialize: (data, context) => {
      const geometry = context.getGeometry?.(num(data.geometryId));
      const material = context.getMaterial?.(num(data.materialId));
      return geometry && material ? new Mesh3D(geometry, material) : null;
    },
  })
  .register({
    type: 'Mesh2D',
    ctor: Mesh2D,
    serialize: (component, context) => ({ type: 'Mesh2D', positions: encodeFloat32(component.geometry.positions, context), indices: component.geometry.indices ? encodeIndex(component.geometry.indices, context) : null, indexType: component.geometry.indices instanceof Uint32Array ? 'uint32' : component.geometry.indices instanceof Uint16Array ? 'uint16' : null, topology: component.geometry.topology, color: color(component.material.color), blending: component.material.blending }),
    deserialize: (data, context) => new Mesh2D(new Geometry2D(decodeFloat32(data.positions, context), decodeIndex(data.indices, data.indexType === 'uint32' ? 'uint32' : data.indexType === 'uint16' ? 'uint16' : null, context), { topology: data.topology as GPUPrimitiveTopology | null ?? null }), new Material2D({ color: color(data.color), blending: blend2D(data.blending) })),
  })
  .register({
    type: 'ClippingPlanes',
    ctor: ClippingPlanes,
    serialize: component => ({
      type: 'ClippingPlanes',
      planes: Array.from({ length: component.count }, (_, index) => component.getPlane(index)),
    }),
    deserialize: data => new ClippingPlanes({ planes: clippingPlanes(data.planes) }),
  })
  .register({
    type: 'PlanarMirror',
    ctor: PlanarMirror,
    serialize: component => ({
      type: 'PlanarMirror',
      localNormal: vec3(component.localNormal, [0, 0, 1]),
      resolutionScale: component.resolutionScale,
      bounceResolutionScale: component.bounceResolutionScale,
      width: component.width,
      height: component.height,
      clipBias: component.clipBias,
      maxBounces: component.maxBounces,
      updateInterval: component.updateInterval,
      staticCache: component.staticCache,
      sampleCount: component.sampleCount,
      clearColor: [component.clearColor.r, component.clearColor.g, component.clearColor.b, component.clearColor.a],
      tint: vec3(component.material.tint, [1, 1, 1]),
      reflectivity: component.material.reflectivity,
    }),
    deserialize: data => {
      const clearColor = color(data.clearColor, [0.02, 0.02, 0.025, 1]);
      return new PlanarMirror({
        localNormal: vec3(data.localNormal, [0, 0, 1]),
        resolutionScale: Math.max(0.01, num(data.resolutionScale, 0.5)),
        bounceResolutionScale: Math.min(1, Math.max(0.01, num(data.bounceResolutionScale, 0.85))),
        ...(data.width == null ? {} : { width: Math.max(1, num(data.width, 1)) }),
        ...(data.height == null ? {} : { height: Math.max(1, num(data.height, 1)) }),
        clipBias: Math.max(0, num(data.clipBias, 0.01)),
        maxBounces: Math.min(8, Math.max(1, Math.floor(num(data.maxBounces, 1)))),
        updateInterval: Math.max(1, Math.floor(num(data.updateInterval, 1))),
        staticCache: bool(data.staticCache, false),
        sampleCount: data.sampleCount === 4 ? 4 : 1,
        clearColor: { r: clearColor[0], g: clearColor[1], b: clearColor[2], a: clearColor[3] },
        tint: vec3(data.tint, [1, 1, 1]),
        reflectivity: Math.min(1, Math.max(0, num(data.reflectivity, 1))),
      });
    },
  })
  .register({
    type: 'KeyboardComponent',
    ctor: KeyboardComponent,
    serialize: () => ({ type: 'KeyboardComponent' }),
    deserialize: () => new KeyboardComponent(),
  })
  .register({
    type: 'Physics2DBody',
    ctor: Physics2DBody,
    serialize: component => ({ type: 'Physics2DBody', bodyType: component.type, shape: component.shape, width: component.width, height: component.height, radius: component.radius, density: component.density, friction: component.friction, restitution: component.restitution, fixedRotation: component.fixedRotation, linearDamping: component.linearDamping, angularDamping: component.angularDamping, bullet: component.bullet, allowSleep: component.allowSleep, isSensor: component.isSensor, categoryBits: component.categoryBits, maskBits: component.maskBits, groupIndex: component.groupIndex, syncTransform: component.syncTransform }),
    deserialize: data => new Physics2DBody({ type: data.bodyType === 'static' || data.bodyType === 'kinematic' ? data.bodyType : 'dynamic', shape: data.shape === 'circle' ? 'circle' : 'box', width: num(data.width, 1), height: num(data.height, 1), radius: num(data.radius, 0.5), density: num(data.density, 1), friction: num(data.friction, 0.3), restitution: num(data.restitution), fixedRotation: bool(data.fixedRotation), linearDamping: num(data.linearDamping), angularDamping: num(data.angularDamping), bullet: bool(data.bullet), allowSleep: bool(data.allowSleep, true), isSensor: bool(data.isSensor), categoryBits: num(data.categoryBits, 0x0001), maskBits: num(data.maskBits, 0xffff), groupIndex: num(data.groupIndex), syncTransform: bool(data.syncTransform, true) }),
  })
  .register({
    type: 'Physics2DJoint',
    ctor: Physics2DJoint,
    serialize: component => ({ type: 'Physics2DJoint', jointType: component.type, bodyA: component.bodyA instanceof Entity ? component.bodyA.id : component.bodyA, bodyB: component.bodyB instanceof Entity ? component.bodyB.id : component.bodyB, anchor: component.anchor ? vec2(component.anchor) : null, anchorA: component.anchorA ? vec2(component.anchorA) : null, anchorB: component.anchorB ? vec2(component.anchorB) : null, collideConnected: component.collideConnected, enableLimit: component.enableLimit, lowerAngle: component.lowerAngle, upperAngle: component.upperAngle, enableMotor: component.enableMotor, motorSpeed: component.motorSpeed, maxMotorTorque: component.maxMotorTorque, length: component.length, frequencyHz: component.frequencyHz, dampingRatio: component.dampingRatio }),
    deserialize: data => new Physics2DJoint({ type: data.jointType === 'distance' ? 'distance' : 'revolute', bodyA: physicsJointTarget(data.bodyA), bodyB: physicsJointTarget(data.bodyB), anchor: data.anchor == null ? undefined : vec2(data.anchor), anchorA: data.anchorA == null ? undefined : vec2(data.anchorA), anchorB: data.anchorB == null ? undefined : vec2(data.anchorB), collideConnected: bool(data.collideConnected), enableLimit: bool(data.enableLimit), lowerAngle: num(data.lowerAngle), upperAngle: num(data.upperAngle), enableMotor: bool(data.enableMotor), motorSpeed: num(data.motorSpeed), maxMotorTorque: num(data.maxMotorTorque), length: data.length == null ? undefined : num(data.length), frequencyHz: num(data.frequencyHz), dampingRatio: num(data.dampingRatio) }),
  })
  .register({
    type: 'Physics3DBody',
    ctor: Physics3DBody,
    serialize: component => ({
      type: 'Physics3DBody',
      bodyType: component.type,
      shape: component.shape,
      width: component.width,
      height: component.height,
      depth: component.depth,
      radius: component.radius,
      halfHeight: component.halfHeight,
      density: component.density,
      friction: component.friction,
      restitution: component.restitution,
      linearDamping: component.linearDamping,
      angularDamping: component.angularDamping,
      gravityScale: component.gravityScale,
      ccd: component.ccd,
      allowSleep: component.allowSleep,
      isSensor: component.isSensor,
      categoryBits: component.categoryBits,
      maskBits: component.maskBits,
      lockTranslations: [...component.lockTranslations],
      lockRotations: [...component.lockRotations],
      syncTransform: component.syncTransform,
    }),
    deserialize: data => {
      const bodyType = data.bodyType === 'static' || data.bodyType === 'kinematic' ? data.bodyType : 'dynamic';
      const shape = data.shape === 'sphere' || data.shape === 'capsule' || data.shape === 'cylinder'
        ? data.shape
        : 'box';
      const height = num(data.height, 1);
      const radius = num(data.radius, 0.5);
      return new Physics3DBody({
        type: bodyType,
        shape,
        width: num(data.width, 1),
        height,
        depth: num(data.depth, 1),
        radius,
        halfHeight: num(data.halfHeight, Math.max(0, height * 0.5 - radius)),
        density: num(data.density, bodyType === 'dynamic' ? 1 : 0),
        friction: num(data.friction, 0.5),
        restitution: num(data.restitution, 0.1),
        linearDamping: num(data.linearDamping),
        angularDamping: num(data.angularDamping),
        gravityScale: num(data.gravityScale, 1),
        ccd: bool(data.ccd),
        allowSleep: bool(data.allowSleep, true),
        isSensor: bool(data.isSensor),
        categoryBits: num(data.categoryBits, 0x0001),
        maskBits: num(data.maskBits, 0xffff),
        lockTranslations: bool3(data.lockTranslations),
        lockRotations: bool3(data.lockRotations),
        syncTransform: bool(data.syncTransform, true),
      });
    },
  })
  .register({
    type: 'Physics3DJoint',
    ctor: Physics3DJoint,
    serialize: component => ({
      type: 'Physics3DJoint',
      jointType: component.type,
      bodyA: component.bodyA instanceof Entity ? component.bodyA.id : component.bodyA,
      bodyB: component.bodyB instanceof Entity ? component.bodyB.id : component.bodyB,
      anchorA: [...component.anchorA],
      anchorB: [...component.anchorB],
      axis: [...component.axis],
      frameA: [...component.frameA],
      frameB: [...component.frameB],
      collideConnected: component.collideConnected,
      limits: component.limits ? [...component.limits] : null,
      restLength: component.restLength,
      maxLength: component.maxLength,
      stiffness: component.stiffness,
      damping: component.damping,
    }),
    deserialize: data => new Physics3DJoint({
      type: physics3DJointType(data.jointType),
      bodyA: physicsJointTarget(data.bodyA),
      bodyB: physicsJointTarget(data.bodyB),
      anchorA: vec3(data.anchorA),
      anchorB: vec3(data.anchorB),
      axis: vec3(data.axis, [1, 0, 0]),
      frameA: quat(data.frameA),
      frameB: quat(data.frameB),
      collideConnected: bool(data.collideConnected),
      limits: data.limits == null ? null : vec2(data.limits),
      restLength: num(data.restLength, 1),
      maxLength: num(data.maxLength, 1),
      stiffness: num(data.stiffness, 30),
      damping: num(data.damping, 3),
    }),
  })
  .register({
    type: 'Physics3DBuoyancy',
    ctor: Physics3DBuoyancy,
    serialize: component => ({
      type: 'Physics3DBuoyancy',
      fluidLevel: component.fluidLevel,
      fluidDensity: component.fluidDensity,
      volume: component.volume,
      bodyHeight: component.bodyHeight,
      linearDrag: component.linearDrag,
      angularDrag: component.angularDrag,
      centerOfBuoyancy: [...component.centerOfBuoyancy],
    }),
    deserialize: data => new Physics3DBuoyancy({
      fluidLevel: num(data.fluidLevel),
      fluidDensity: num(data.fluidDensity, 1),
      volume: data.volume == null ? null : num(data.volume),
      bodyHeight: data.bodyHeight == null ? null : num(data.bodyHeight),
      linearDrag: num(data.linearDrag, 1.4),
      angularDrag: num(data.angularDrag, 0.8),
      centerOfBuoyancy: vec3(data.centerOfBuoyancy),
    }),
  })
  .register({
    type: 'Physics3DGravitySource',
    ctor: Physics3DGravitySource,
    serialize: component => ({
      type: 'Physics3DGravitySource',
      strength: component.strength,
      softening: component.softening,
      maxDistance: Number.isFinite(component.maxDistance) ? component.maxDistance : null,
    }),
    deserialize: data => new Physics3DGravitySource({
      strength: num(data.strength, 20),
      softening: num(data.softening, 0.5),
      maxDistance: data.maxDistance == null ? Number.POSITIVE_INFINITY : num(data.maxDistance),
    }),
  })
  .register({
    type: 'Physics2DTo3DTransformSync',
    ctor: Physics2DTo3DTransformSync,
    serialize: component => ({ type: 'Physics2DTo3DTransformSync', sourceEntity: component.sourceEntity instanceof Entity ? component.sourceEntity.id : component.sourceEntity, plane: component.plane, fixedAxisValue: component.fixedAxisValue, offset: vec3(component.offset), syncRotation: component.syncRotation, rotationAxis: component.rotationAxis, rotationOffset: component.rotationOffset }),
    deserialize: data => new Physics2DTo3DTransformSync({ sourceEntity: data.sourceEntity == null ? null : physicsJointTarget(data.sourceEntity), plane: data.plane === 'xz' || data.plane === 'yz' ? data.plane : 'xy', fixedAxisValue: num(data.fixedAxisValue), offset: vec3(data.offset), syncRotation: bool(data.syncRotation, true), rotationAxis: data.rotationAxis === 'x' || data.rotationAxis === 'y' ? data.rotationAxis : 'z', rotationOffset: num(data.rotationOffset) }),
  })
  .register({
    type: 'MeshHelper',
    ctor: MeshHelper,
    serialize: component => ({ type: 'MeshHelper', mode: component.mode, color: color(component.color), lineWidth: component.lineWidth }),
    deserialize: data => new MeshHelper({ mode: data.mode === 'obb' || data.mode === 'wireframe' ? data.mode : 'aabb', color: color(data.color), lineWidth: num(data.lineWidth, 1) }),
  })
  .register({
    type: 'ScriptComponent',
    ctor: ScriptComponent,
    serialize: (component, context) => ({ type: 'ScriptComponent', scriptId: component.resource ? context.getScriptId?.(component.resource) ?? component.resource.id : null, scripts: { ...component.scripts } }),
    deserialize: (data, context) => new ScriptComponent(typed<{ scripts?: Partial<Record<ScriptLifecycleName, string>> } & CoreSerializedComponent>(data).scripts ?? {}, data.scriptId == null ? null : context.getScript?.(num(data.scriptId)) ?? null),
  })
  .register({
    type: 'AmbientLight',
    ctor: AmbientLight,
    serialize: component => ({ type: 'AmbientLight', color: color(component.color), intensity: component.intensity }),
    deserialize: data => new AmbientLight({ color: color(data.color).slice(0, 3) as [number, number, number], intensity: num(data.intensity, 0.1) }),
  })
  .register({
    type: 'DirectionalLight',
    ctor: DirectionalLight,
    serialize: component => ({ type: 'DirectionalLight', color: color(component.color), intensity: component.intensity, direction: vec3(component.direction), castShadow: component.castShadow, shadow: { ...component.shadow } }),
    deserialize: data => {
      const shadow = record(data.shadow);
      const mapSize = num(shadow.mapSize, 1024);
      return new DirectionalLight({
        color: color(data.color).slice(0, 3) as [number, number, number],
        intensity: num(data.intensity, 1),
        direction: vec3(data.direction, [0, -1, 0]),
        castShadow: bool(data.castShadow, true),
        shadow: {
          mapSize: mapSize === 512 || mapSize === 2048 ? mapSize : 1024,
          extent: num(shadow.extent, 20), near: num(shadow.near, 0.1), far: num(shadow.far, 60),
          bias: num(shadow.bias, 0.0015), normalBias: num(shadow.normalBias, 0.02),
        },
      });
    },
  })
  .register({
    type: 'EnvironmentLight',
    ctor: EnvironmentLight,
    serialize: component => ({ type: 'EnvironmentLight', intensity: component.intensity, rotation: component.rotation, diffuseColor: color(component.diffuseColor), specularColor: color(component.specularColor) }),
    deserialize: data => new EnvironmentLight({
      intensity: num(data.intensity, 1), rotation: num(data.rotation),
      diffuseColor: color(data.diffuseColor).slice(0, 3) as [number, number, number],
      specularColor: color(data.specularColor).slice(0, 3) as [number, number, number],
    }),
  })
  .register({
    type: 'Fog',
    ctor: Fog,
    serialize: component => ({
      type: 'Fog',
      mode: component.mode,
      color: color(component.color),
      maxOpacity: component.maxOpacity,
      distanceStart: component.distanceStart,
      distanceEnd: component.distanceEnd,
      baseHeight: component.baseHeight,
      density: component.density,
      heightFalloff: component.heightFalloff,
    }),
    deserialize: data => new Fog({
      mode: data.mode === 'height' ? 'height' : 'distance',
      color: color(data.color, [0.62, 0.7, 0.8, 1]),
      maxOpacity: num(data.maxOpacity, 1),
      distanceStart: num(data.distanceStart, 10),
      distanceEnd: num(data.distanceEnd, 60),
      baseHeight: num(data.baseHeight),
      density: num(data.density, 0.04),
      heightFalloff: num(data.heightFalloff, 0.2),
    }),
  })
  .register({
    type: 'PointLight',
    ctor: PointLight,
    serialize: component => ({ type: 'PointLight', color: color(component.color), intensity: component.intensity, range: component.range }),
    deserialize: data => new PointLight({ color: color(data.color).slice(0, 3) as [number, number, number], intensity: num(data.intensity, 1), range: num(data.range, 10) }),
  });
