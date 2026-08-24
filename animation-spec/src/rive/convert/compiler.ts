import { encodeAnimationBinary } from '../../binary.js';
import { AnimationExtensionRegistry } from '../../extensions.js';
import { parseAnimation } from '../../parser.js';
import type { AnimationDocument, AnimationResource, AnimationTrack } from '../../types.js';
import { parseVectorVisualDocument } from '../../vector2d/parser.js';
import { parseParameterizedRigDocument } from '../../deformable2d/parameterized/parser.js';
import { PARAMETERIZED_RIG_EXTENSION_ID } from '../../deformable2d/parameterized/types.js';
import { parseResponsiveLayoutDocument } from '../../layout2d/parameterized/parser.js';
import { LAYOUT_EXTENSION_ID } from '../../layout2d/parameterized/types.js';
import { parseHyaStateMachineV2 } from '../../state-machine-v2/parser.js';
import { HYA_STATE_MACHINE_V2_EXTENSION_ID } from '../../state-machine-v2/types.js';
import { parseHyaDataBinding } from '../../data-binding/parser.js';
import { HYA_DATA_BINDING_EXTENSION_ID } from '../../data-binding/types.js';
import { parseHyaInteraction } from '../../interaction/parser.js';
import { HYA_INTERACTION_EXTENSION_ID } from '../../interaction/types.js';
import { parseHyaSemantics } from '../../semantics/parser.js';
import { HYA_SEMANTICS_EXTENSION_ID } from '../../semantics/types.js';
import { parseHyaAudioEvents } from '../../audio/parser.js';
import { HYA_AUDIO_EVENT_EXTENSION_ID } from '../../audio/types.js';
import { parseSandboxedAnimationScriptDocument } from '../../script/parser.js';
import { SANDBOXED_ANIMATION_SCRIPT_EXTENSION } from '../../script/types.js';
import type { AdaptedRiveConversion } from './adapter.js';
import type { RiveNeutralCapability } from './types.js';
import type { PreparedRiveAssets } from './package.js';
import { conversionFail } from './diagnostics.js';
import { canonicalClone, compareUtf8, stableJsonBytes } from './stable.js';

export interface CompiledRiveFile { readonly path: string; readonly mediaType: string; readonly bytes: Uint8Array; }
export interface CompiledRiveConversion { readonly hyaBytes: Uint8Array; readonly files: readonly CompiledRiveFile[]; }

const CAPABILITY_EXTENSION: Readonly<Partial<Record<RiveNeutralCapability, string>>> = Object.freeze({
  'deformable-rig': PARAMETERIZED_RIG_EXTENSION_ID,
  'responsive-layout': LAYOUT_EXTENSION_ID,
  'state-machine': HYA_STATE_MACHINE_V2_EXTENSION_ID,
  'data-binding': HYA_DATA_BINDING_EXTENSION_ID,
  interaction: HYA_INTERACTION_EXTENSION_ID,
  semantics: HYA_SEMANTICS_EXTENSION_ID,
  'audio-events': HYA_AUDIO_EVENT_EXTENSION_ID,
  'sandbox-script': SANDBOXED_ANIMATION_SCRIPT_EXTENSION,
});

const CORE_EXTENSION_IDS = new Set([
  'org.haiyue.vector-shape@1',
  'org.haiyue.vector-stroke@1',
  'org.haiyue.vector-path-morph@1',
]);

export function compileRiveNeutralPlan(adapted: AdaptedRiveConversion, bakedTracks: readonly AnimationTrack[], preparedAssets: PreparedRiveAssets): CompiledRiveConversion {
  const base = canonicalClone(adapted.evaluation.baseDocument, '$.evaluation.baseDocument');
  const artifactFiles: CompiledRiveFile[] = [];
  const extensionDocuments: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const capabilitySeen = new Set<RiveNeutralCapability>();
  for (let index = 0; index < adapted.artifacts.length; index++) {
    const artifact = adapted.artifacts[index]!;
    const path = `$.evaluation.artifacts[${index}].document`;
    validateCapabilityDocument(artifact.capability, artifact.document, path);
    const extension = CAPABILITY_EXTENSION[artifact.capability];
    if (extension) {
      if (capabilitySeen.has(artifact.capability)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Only one document is allowed for this versioned HYA capability.', path);
      capabilitySeen.add(artifact.capability);
      extensionDocuments[extension] = canonicalClone(artifact.document, path);
    }
    artifactFiles.push(Object.freeze({
      path: `sidecars/${artifact.capability}/${artifact.id}.json`,
      mediaType: capabilityMediaType(artifact.capability),
      bytes: stableJsonBytes(artifact.document),
    }));
  }

  const used = new Set(base.extensionsUsed ?? []);
  const required = new Set(base.extensionsRequired ?? []);
  const baseExtensions = { ...(base.extensions ?? {}) };
  for (const id of [...used, ...required]) {
    if (!CORE_EXTENSION_IDS.has(id)) conversionFail('E_RIVE_CONVERT_UNSUPPORTED', `Base HYA declares an extension not owned by the neutral core: ${id}.`, '$.evaluation.baseDocument.extensionsUsed');
  }
  for (const [id, document] of Object.entries(extensionDocuments)) { used.add(id); required.add(id); baseExtensions[id] = document; }
  const resources = rewriteAssetResources(base.resources ?? [], preparedAssets);
  const tracks = [...(base.tracks ?? []), ...bakedTracks];
  rejectDuplicateTracks(tracks);
  const document: AnimationDocument = {
    ...base,
    resources,
    tracks,
    extensionsUsed: [...used].sort(compareUtf8),
    extensionsRequired: [...required].sort(compareUtf8),
    extensions: baseExtensions,
  };
  const registry = createConverterExtensionRegistry(extensionDocuments);
  try {
    parseAnimation(document, { extensions: registry });
    const encoded = encodeAnimationBinary(document, { extensions: registry });
    parseAnimation(encoded, { extensions: registry });
    const hyaBytes = new Uint8Array(encoded);
    return Object.freeze({
      hyaBytes,
      files: Object.freeze([
        Object.freeze({ path: 'animation.hya', mediaType: 'application/vnd.haiyue.animation', bytes: hyaBytes }),
        ...artifactFiles.sort((left, right) => compareUtf8(left.path, right.path)),
      ]),
    });
  } catch (error) {
    conversionFail('E_RIVE_CONVERT_FORMAT', `Compiled HYA failed its binary round-trip: ${error instanceof Error ? error.message : String(error)}`, '$.evaluation.baseDocument', undefined, error);
  }
}

function validateCapabilityDocument(capability: RiveNeutralCapability, document: unknown, path: string): void {
  try {
    switch (capability) {
      case 'vector-visual': parseVectorVisualDocument(document); return;
      case 'deformable-rig': parseParameterizedRigDocument(document); return;
      case 'responsive-layout': parseResponsiveLayoutDocument(document); return;
      case 'state-machine': parseHyaStateMachineV2(document); return;
      case 'data-binding': parseHyaDataBinding(document); return;
      case 'interaction': parseHyaInteraction(document); return;
      case 'semantics': parseHyaSemantics(document); return;
      case 'audio-events': parseHyaAudioEvents(document); return;
      case 'sandbox-script': parseSandboxedAnimationScriptDocument(document); return;
    }
  } catch (error) {
    conversionFail('E_RIVE_CONVERT_FORMAT', `${capability} artifact violates its frozen contract: ${error instanceof Error ? error.message : String(error)}`, path, undefined, error);
  }
}

function createConverterExtensionRegistry(documents: Readonly<Record<string, unknown>>): AnimationExtensionRegistry {
  const registry = new AnimationExtensionRegistry();
  for (const id of CORE_EXTENSION_IDS) registry.register({ id });
  for (const id of Object.keys(documents)) registry.register({
    id,
    validateDocument(data, context) {
      const capability = (Object.entries(CAPABILITY_EXTENSION).find(([, extension]) => extension === id)?.[0]) as RiveNeutralCapability | undefined;
      if (capability === undefined) return context.fail('Converter extension dispatch is missing.');
      try { validateCapabilityDocument(capability, data, context.path); }
      catch (error) { context.fail(error instanceof Error ? error.message : String(error)); }
    },
  });
  return registry;
}

function rewriteAssetResources(resources: readonly AnimationResource[], prepared: PreparedRiveAssets): readonly AnimationResource[] {
  const referenced = new Set<string>();
  const result = resources.map((resource, index) => {
    if (!resource.uri.startsWith('asset:')) return Object.freeze({ ...resource });
    const id = resource.uri.slice('asset:'.length);
    const asset = prepared.byId.get(id);
    if (!asset) conversionFail('E_RIVE_CONVERT_ASSET_MISSING', `HYA resource references missing asset "${id}".`, `$.evaluation.baseDocument.resources[${index}].uri`);
    referenced.add(id);
    return Object.freeze({ ...resource, uri: asset.path ?? asset.uri!, integrity: `sha256-${asset.sha256}`, mimeType: resource.mimeType ?? asset.mimeType });
  });
  for (const id of prepared.byId.keys()) if (!referenced.has(id)) conversionFail('E_RIVE_CONVERT_ASSET_MISSING', `Declared converter asset "${id}" is not referenced by the HYA document.`, '$.evaluation.assets');
  return Object.freeze(result);
}

function rejectDuplicateTracks(tracks: readonly AnimationTrack[]): void {
  const seen = new Set<string>();
  tracks.forEach((track, index) => {
    const key = `${track.node}\0${track.property}`;
    if (seen.has(key)) conversionFail('E_RIVE_CONVERT_FORMAT', 'HYA contains duplicate tracks for one node/property pair.', `$.tracks[${index}]`);
    seen.add(key);
  });
}

function capabilityMediaType(capability: RiveNeutralCapability): string { return `application/vnd.haiyue.${capability}+json`; }
