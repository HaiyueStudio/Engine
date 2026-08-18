import { EngineError, EngineErrorCode } from '@haiyue/engine';
import { ErrorDomain, ErrorRecovery } from '@haiyue/engine/core';

export interface BoneData {
  name: string;
  parent?: string;
  inherit?: string;
  x: number;
  y: number;
  rotation: number;
  shearX: number;
  shearY: number;
  scaleX: number;
  scaleY: number;
  length: number;
}

export interface IkConstraintData {
  name: string;
  order: number;
  skin: boolean;
  bones: string[];
  target: string;
  mix: number;
  softness: number;
  bendPositive: boolean;
}

export interface TransformConstraintData {
  name: string;
  order: number;
  skin: boolean;
  bones: string[];
  target: string;
  rotation: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  shearY: number;
  mixRotate: number;
  mixX: number;
  mixY: number;
  mixScaleX: number;
  mixScaleY: number;
  mixShearY: number;
  localSource: boolean;
  localTarget: boolean;
  additive: boolean;
}

export interface PathConstraintData {
  name: string;
  order: number;
  skin: boolean;
  bones: string[];
  slot: string;
  position: number;
  spacing: number;
  mixRotate: number;
  mixX: number;
  mixY: number;
  positionMode: string;
  spacingMode: string;
  rotateMode: string;
  offsetRotation: number;
}

export interface SliderConstraintData {
  name: string;
  order: number;
  skin: boolean;
  animation: string;
  bone?: string;
  property: string;
  scale: number;
  offset: number;
  loop: boolean;
  local: boolean;
  mix: number;
}

export interface SlotData {
  name: string;
  bone: string;
  attachment?: string;
  color?: [number, number, number, number];
  blend: 'normal' | 'additive' | string;
}

export interface RegionAttachment {
  type?: string;
  name: string;
  path: string;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
  color?: [number, number, number, number];
  uvs?: number[];
  triangles?: number[];
  vertices?: number[];
  vertexCount?: number;
  lengths?: number[];
  sequence?: { count?: number; start?: number; digits?: number; setup?: number };
  closed?: boolean;
  constantSpeed?: boolean;
  end?: string;
  skin?: string;
  source?: string;
}

export interface SpineAnimationBoneTimelines {
  rotate?: unknown[];
  translate?: unknown[];
  scale?: unknown[];
  shear?: unknown[];
  [timeline: string]: unknown;
}

export interface SpineAnimationData {
  bones?: Record<string, SpineAnimationBoneTimelines>;
  slots?: Record<string, {
    attachment?: Array<{ time?: number; name?: string | null }>;
    rgba?: unknown[];
    [timeline: string]: unknown;
  }>;
  attachments?: Record<string, Record<string, Record<string, { sequence?: unknown[] }>>>;
  ik?: Record<string, unknown[]>;
  transform?: Record<string, unknown[]>;
  path?: Record<string, unknown[]>;
  slider?: Record<string, { mix?: unknown[] }>;
  drawOrder?: Array<{ time?: number; offsets?: Array<{ slot: string; offset?: number }> }>;
  [timeline: string]: unknown;
}

export interface SpineData {
  bones: BoneData[];
  ik: IkConstraintData[];
  transform: TransformConstraintData[];
  path: PathConstraintData[];
  sliders: SliderConstraintData[];
  slots: SlotData[];
  skins: Record<string, Record<string, Record<string, RegionAttachment>>>;
  skinConstraints: Record<string, { ik: string[]; transform: string[]; path: string[]; slider: string[] }>;
  animations: Record<string, SpineAnimationData>;
}

export interface BonePose {
  data: BoneData;
  a: number;
  b: number;
  c: number;
  d: number;
  worldX: number;
  worldY: number;
  rotation: number;
  shearX: number;
  shearY: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

export interface SliderAnimationState {
  animation: string;
  time: number;
  loop: boolean;
  mix: number;
}

export function normalizeSpineData(input: unknown): SpineData {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalidSpineData('Spine JSON root must be an object.', 'spine');
  }
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.bones)) throw invalidSpineData('Spine JSON bones must be an array.', 'spine.bones');
  if (!Array.isArray(record.slots)) throw invalidSpineData('Spine JSON slots must be an array.', 'spine.slots');
  for (const [index, bone] of record.bones.entries()) {
    if (typeof bone !== 'object' || bone === null || typeof (bone as Record<string, unknown>).name !== 'string') {
      throw invalidSpineData(`Spine bone ${index} must include a string name.`, `spine.bones[${index}].name`);
    }
  }
  for (const [index, slot] of record.slots.entries()) {
    if (typeof slot !== 'object' || slot === null || typeof (slot as Record<string, unknown>).name !== 'string') {
      throw invalidSpineData(`Spine slot ${index} must include a string name.`, `spine.slots[${index}].name`);
    }
  }
  return normalizeValidatedSpineData(record as unknown as SpineSourceDocument);
}

// Spine JSON is an open, version-dependent third-party schema. Dynamic access is
// intentionally confined to this normalization adapter; domain code consumes SpineData.
function normalizeValidatedSpineData(input: SpineSourceDocument): SpineData {
  const skins: SpineData['skins'] = {};
  const skinConstraints: SpineData['skinConstraints'] = {};
  if (Array.isArray(input.skins)) {
    for (const skin of input.skins) {
      const name = skin.name || 'default';
      skins[name] = normalizeSkinAttachments(skin.attachments);
      skinConstraints[name] = {
        ik: skin.ik ?? [],
        transform: skin.transform ?? [],
        path: skin.path ?? [],
        slider: skin.slider ?? skin.sliders ?? [],
      };
    }
  } else {
    for (const [name, attachments] of Object.entries(input.skins ?? {})) {
      skins[name] = normalizeSkinAttachments(attachments);
    }
    for (const name of Object.keys(skins)) skinConstraints[name] = { ik: [], transform: [], path: [], slider: [] };
  }
  resolveLinkedMeshes(skins);
  const constraints = Array.isArray(input.constraints)
    ? input.constraints.map((constraint, index) => ({ ...constraint, __order: index }))
    : null;
  const ikConstraints = constraints
    ? constraints.filter(constraint => constraint.type === 'ik')
    : (input.ik ?? []);
  const transformConstraints = constraints
    ? constraints.filter(constraint => constraint.type === 'transform')
    : (input.transform ?? []);
  const pathConstraints = constraints
    ? constraints.filter(constraint => constraint.type === 'path')
    : (input.path ?? []);
  const sliderConstraints = constraints
    ? constraints.filter(constraint => constraint.type === 'slider')
    : (input.sliders ?? input.slider ?? []);
  return {
    bones: (input.bones ?? []).map(bone => ({
      name: bone.name,
      ...(bone.parent === undefined ? {} : { parent: bone.parent }),
      ...(bone.inherit === undefined ? {} : { inherit: bone.inherit }),
      x: bone.x ?? 0,
      y: bone.y ?? 0,
      rotation: bone.rotation ?? 0,
      shearX: bone.shearX ?? 0,
      shearY: bone.shearY ?? 0,
      scaleX: bone.scaleX ?? 1,
      scaleY: bone.scaleY ?? 1,
      length: bone.length ?? 0,
    })),
    ik: ikConstraints.map((constraint, index) => ({
      name: constraint.name,
      order: constraint.order ?? constraint.__order ?? index,
      skin: constraint.skin ?? false,
      bones: constraint.bones ?? [],
      target: constraint.target ?? constraint.source ?? '',
      mix: constraint.mix ?? 1,
      softness: constraint.softness ?? 0,
      bendPositive: constraint.bendPositive ?? true,
    })),
    transform: transformConstraints.map((constraint, index) => ({
      name: constraint.name,
      order: constraint.order ?? constraint.__order ?? index,
      skin: constraint.skin ?? false,
      bones: constraint.bones ?? [],
      target: constraint.target ?? constraint.source ?? '',
      rotation: constraint.rotation ?? 0,
      x: constraint.x ?? 0,
      y: constraint.y ?? 0,
      scaleX: constraint.scaleX ?? 0,
      scaleY: constraint.scaleY ?? 0,
      shearY: constraint.shearY ?? 0,
      ...normalizeTransformMixes(constraint),
      localSource: constraint.localSource ?? false,
      localTarget: constraint.localTarget ?? false,
      additive: constraint.additive ?? false,
    })),
    path: pathConstraints.map((constraint, index) => ({
      name: constraint.name,
      order: constraint.order ?? constraint.__order ?? index,
      skin: constraint.skin ?? false,
      bones: constraint.bones ?? [],
      slot: constraint.slot ?? '',
      position: constraint.position ?? 0,
      spacing: constraint.spacing ?? 0,
      mixRotate: constraint.mixRotate ?? 1,
      mixX: constraint.mixX ?? 1,
      mixY: constraint.mixY ?? constraint.mixX ?? 1,
      positionMode: constraint.positionMode ?? 'percent',
      spacingMode: constraint.spacingMode ?? 'length',
      rotateMode: constraint.rotateMode ?? 'tangent',
      offsetRotation: constraint.rotation ?? 0,
    })),
    sliders: sliderConstraints.map((constraint, index) => ({
      name: constraint.name,
      order: constraint.order ?? constraint.__order ?? index,
      skin: constraint.skin ?? false,
      animation: constraint.animation ?? '',
      ...(constraint.bone === undefined ? {} : { bone: constraint.bone }),
      property: constraint.property ?? 'rotate',
      scale: constraint.scale ?? 1,
      offset: constraint.offset ?? 0,
      loop: constraint.loop ?? false,
      local: constraint.local ?? false,
      mix: constraint.mix ?? 1,
    })),
    slots: (input.slots ?? []).map(slot => {
      const color = parseColor(slot.color);
      return {
        name: slot.name,
        bone: slot.bone,
        ...(slot.attachment === undefined ? {} : { attachment: slot.attachment }),
        ...(color === undefined ? {} : { color }),
        blend: slot.blend ?? 'normal',
      };
    }),
    skins,
    skinConstraints,
    animations: input.animations ?? {},
  };
}

function invalidSpineData(message: string, path: string): EngineError {
  return new EngineError(EngineErrorCode.AssetInvalidData, message, {
    domain: ErrorDomain.Component,
    recovery: ErrorRecovery.ReleaseResource,
    context: { resourceType: 'skeleton/spine' },
    path,
  });
}

export function parseColor(value?: string): [number, number, number, number] | undefined {
  if (!value || value.length < 8) return undefined;
  return [
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255,
    parseInt(value.slice(6, 8), 16) / 255,
  ];
}

function resolveLinkedMeshes(skins: SpineData['skins']): void {
  for (const [skinName, skin] of Object.entries(skins)) {
    for (const [slotName, attachments] of Object.entries(skin)) {
      for (const [attachmentName, attachment] of Object.entries(attachments)) {
        if (attachment.type !== 'linkedmesh') continue;
        const sourceSkinName = attachment.skin ?? skinName;
        const sourceName = attachment.source ?? attachmentName;
        const source = skins[sourceSkinName]?.[slotName]?.[sourceName] ?? skins.default?.[slotName]?.[sourceName];
        if (!source) continue;
        attachments[attachmentName] = {
          ...source,
          ...attachment,
          type: source.type ?? 'mesh',
          ...(source.uvs === undefined ? {} : { uvs: source.uvs }),
          ...(source.triangles === undefined ? {} : { triangles: source.triangles }),
          ...(source.vertices === undefined ? {} : { vertices: source.vertices }),
          ...(source.vertexCount === undefined ? {} : { vertexCount: source.vertexCount }),
        };
      }
    }
  }
}

function normalizeSkinAttachments(attachments: SpineSourceSkinAttachments | undefined): Record<string, Record<string, RegionAttachment>> {
  const normalized: Record<string, Record<string, RegionAttachment>> = {};
  for (const [slotName, slotAttachments] of Object.entries(attachments ?? {})) {
    normalized[slotName] = {};
    for (const [attachmentName, attachment] of Object.entries(slotAttachments ?? {})) {
      const { color: rawColor, ...attachmentFields } = attachment;
      const color = typeof rawColor === 'string' ? parseColor(rawColor) : rawColor;
      normalized[slotName][attachmentName] = {
        ...attachmentFields,
        name: attachment.name ?? attachmentName,
        path: attachment.path ?? attachment.name ?? attachmentName,
        x: attachment.x ?? 0,
        y: attachment.y ?? 0,
        rotation: attachment.rotation ?? 0,
        scaleX: attachment.scaleX ?? 1,
        scaleY: attachment.scaleY ?? 1,
        width: attachment.width ?? 0,
        height: attachment.height ?? 0,
        ...(color === undefined ? {} : { color }),
      };
    }
  }
  return normalized;
}

function normalizeTransformMixes(constraint: SpineSourceConstraint): Pick<
  TransformConstraintData,
  'mixRotate' | 'mixX' | 'mixY' | 'mixScaleX' | 'mixScaleY' | 'mixShearY'
> {
  const targets = getTransformPropertyTargets(constraint.properties);
  if (!targets) {
    return {
      mixRotate: constraint.mixRotate ?? 1,
      mixX: constraint.mixX ?? 1,
      mixY: constraint.mixY ?? constraint.mixX ?? 1,
      mixScaleX: constraint.mixScaleX ?? 1,
      mixScaleY: constraint.mixScaleY ?? constraint.mixScaleX ?? 1,
      mixShearY: constraint.mixShearY ?? 1,
    };
  }
  return {
    mixRotate: targets.rotate ? constraint.mixRotate ?? 1 : 0,
    mixX: targets.x ? constraint.mixX ?? 1 : 0,
    mixY: targets.y ? constraint.mixY ?? constraint.mixX ?? 1 : 0,
    mixScaleX: targets.scaleX ? constraint.mixScaleX ?? 1 : 0,
    mixScaleY: targets.scaleY ? constraint.mixScaleY ?? constraint.mixScaleX ?? 1 : 0,
    mixShearY: targets.shearY ? constraint.mixShearY ?? 1 : 0,
  };
}

function getTransformPropertyTargets(properties: unknown): Record<'rotate' | 'x' | 'y' | 'scaleX' | 'scaleY' | 'shearY', boolean> | null {
  if (!properties || typeof properties !== 'object') return null;
  const targets = { rotate: false, x: false, y: false, scaleX: false, scaleY: false, shearY: false };
  let hasTarget = false;
  for (const from of Object.values(properties)) {
    if (!from || typeof from !== 'object') continue;
    const to = (from as Record<string, unknown>).to;
    if (!to || typeof to !== 'object') continue;
    for (const name of Object.keys(to)) {
      if (name in targets) {
        targets[name as keyof typeof targets] = true;
        hasTarget = true;
      }
    }
  }
  return hasTarget ? targets : null;
}

type SpineSourceAttachment = Partial<Omit<RegionAttachment, 'color'>> & {
  color?: string | [number, number, number, number];
};
type SpineSourceSkinAttachments = Record<string, Record<string, SpineSourceAttachment>>;

interface SpineSourceSkin {
  name?: string;
  attachments?: SpineSourceSkinAttachments;
  ik?: string[];
  transform?: string[];
  path?: string[];
  slider?: string[];
  sliders?: string[];
}

interface SpineSourceConstraint {
  type?: 'ik' | 'transform' | 'path' | 'slider' | string;
  __order?: number;
  name: string;
  order?: number;
  skin?: boolean;
  bones?: string[];
  target?: string;
  source?: string;
  mix?: number;
  softness?: number;
  bendPositive?: boolean;
  rotation?: number;
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  shearY?: number;
  mixRotate?: number;
  mixX?: number;
  mixY?: number;
  mixScaleX?: number;
  mixScaleY?: number;
  mixShearY?: number;
  localSource?: boolean;
  localTarget?: boolean;
  additive?: boolean;
  properties?: unknown;
  slot?: string;
  position?: number;
  spacing?: number;
  positionMode?: string;
  spacingMode?: string;
  rotateMode?: string;
  animation?: string;
  bone?: string;
  property?: string;
  scale?: number;
  offset?: number;
  loop?: boolean;
  local?: boolean;
}

interface SpineSourceBone {
  name: string;
  parent?: string;
  inherit?: string;
  x?: number;
  y?: number;
  rotation?: number;
  shearX?: number;
  shearY?: number;
  scaleX?: number;
  scaleY?: number;
  length?: number;
}

interface SpineSourceSlot {
  name: string;
  bone: string;
  attachment?: string;
  color?: string;
  blend?: string;
}

interface SpineSourceDocument {
  bones?: SpineSourceBone[];
  slots?: SpineSourceSlot[];
  skins?: SpineSourceSkin[] | Record<string, SpineSourceSkinAttachments>;
  constraints?: SpineSourceConstraint[];
  ik?: SpineSourceConstraint[];
  transform?: SpineSourceConstraint[];
  path?: SpineSourceConstraint[];
  sliders?: SpineSourceConstraint[];
  slider?: SpineSourceConstraint[];
  animations?: Record<string, SpineAnimationData>;
}
