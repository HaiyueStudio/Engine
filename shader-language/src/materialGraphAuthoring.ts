import type {
  ShaderCapabilityProfile,
  ShaderDiagnostic,
  ShaderResourceReflection,
  ShaderUniformBlockReflection,
} from './contracts';
import { ShaderComposerError } from './diagnostics';
import type { ShaderGraphResourceV1, ShaderGraphV1 } from './graph/contracts';
import { compileMaterialGraphV1 } from './graph/materialCompiler';
import {
  getMaterialGraphNodeCatalogV1,
  type MaterialGraphNodeDescriptorV1,
} from './graph/nodeRegistry';

export const MATERIAL_GRAPH_ARTIFACT_FORMAT = 'haiyue-material-graph-artifact@1' as const;

export const MATERIAL_GRAPH_SURFACE_SLOTS_V1 = Object.freeze([
  'baseColor', 'opacity', 'normalTS', 'metallic', 'roughness', 'occlusion', 'emissive',
  'transmission', 'thickness', 'clearcoat', 'clearcoatRoughness', 'clearcoatNormalTS',
  'sheenColor', 'sheenRoughness',
] as const);

/** JSON authoring schema. Compiler-normalized locations and IR values are intentionally absent. */
export interface MaterialGraphDocumentV1 {
  readonly format: 'haiyue-shader-graph';
  readonly version: 1;
  readonly kind: 'material';
  readonly profile: ShaderCapabilityProfile;
  readonly resources: readonly ShaderGraphResourceV1[];
  readonly nodes: readonly Readonly<{
    id: string;
    type: string;
    typeVersion: number;
    inputs: Readonly<Record<string, unknown>>;
    metadata?: Readonly<Record<string, unknown>>;
  }>[];
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly sceneFeatures?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MaterialGraphCompileDiagnostic {
  readonly severity: 'error';
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface MaterialGraphDeploymentArtifactV1 {
  readonly format: typeof MATERIAL_GRAPH_ARTIFACT_FORMAT;
  readonly graph: Pick<ShaderGraphV1, 'format' | 'version' | 'kind' | 'profile'>;
  readonly canonicalHash: string;
  readonly variantKey: string;
  readonly source: Readonly<{ target: 'wgsl'; code: string; bytes: number }>;
  readonly reflection: Readonly<{
    resources: readonly ShaderResourceReflection[];
    uniformBlocks: readonly ShaderUniformBlockReflection[];
    vertexSemantics: readonly string[];
    passRequirements: readonly string[];
  }>;
  readonly cost: Readonly<{
    nodeCount: number;
    resourceCount: number;
    sourceBytes: number;
    reachableVariants: number;
    maximumVariants: number;
  }>;
  /** The compiler is production-ready; renderer material binding remains a separate capability. */
  readonly runtimeAdapter: 'renderer-adapter-required';
}

export type MaterialGraphCompileResult =
  | Readonly<{ ok: true; artifact: MaterialGraphDeploymentArtifactV1 }>
  | Readonly<{ ok: false; diagnostics: readonly MaterialGraphCompileDiagnostic[] }>;

/**
 * High-level Material Graph authoring boundary. Consumers receive a deployable
 * source/reflection artifact and never observe Typed IR or compiler builders.
 */
export function compileMaterialGraphDocumentV1(input: string | unknown): MaterialGraphCompileResult {
  try {
    const compiled = compileMaterialGraphV1(input, { id: 'editor.material-graph' });
    const sourceBytes = new TextEncoder().encode(compiled.composition.code).byteLength;
    return Object.freeze({
      ok: true as const,
      artifact: Object.freeze({
        format: MATERIAL_GRAPH_ARTIFACT_FORMAT,
        graph: Object.freeze({
          format: compiled.graph.format,
          version: compiled.graph.version,
          kind: compiled.graph.kind,
          profile: compiled.graph.profile,
        }),
        canonicalHash: compiled.canonicalHash,
        variantKey: compiled.composition.variantKey,
        source: Object.freeze({ target: 'wgsl' as const, code: compiled.composition.code, bytes: sourceBytes }),
        reflection: Object.freeze({
          resources: compiled.composition.reflection.resources,
          uniformBlocks: compiled.composition.reflection.uniformBlocks,
          vertexSemantics: compiled.vertexSemantics,
          passRequirements: compiled.composition.reflection.passRequirements,
        }),
        cost: Object.freeze({
          nodeCount: compiled.graph.nodes.length,
          resourceCount: compiled.graph.resources.length,
          sourceBytes,
          reachableVariants: compiled.variantPolicy.reachablePilotFamilyVariants,
          maximumVariants: compiled.variantPolicy.maximumPilotFamilyVariants,
        }),
        runtimeAdapter: 'renderer-adapter-required' as const,
      }),
    });
  } catch (error) {
    const diagnostic = toAuthoringDiagnostic(error);
    return Object.freeze({ ok: false as const, diagnostics: Object.freeze([diagnostic]) });
  }
}

export function getMaterialGraphAuthoringCatalogV1(): readonly MaterialGraphNodeDescriptorV1[] {
  return getMaterialGraphNodeCatalogV1();
}

export function getMaterialGraphSurfaceSlotsV1(): typeof MATERIAL_GRAPH_SURFACE_SLOTS_V1 {
  return MATERIAL_GRAPH_SURFACE_SLOTS_V1;
}

function toAuthoringDiagnostic(error: unknown): MaterialGraphCompileDiagnostic {
  const source: ShaderDiagnostic | null = error instanceof ShaderComposerError ? error.diagnostic : null;
  return Object.freeze({
    severity: 'error' as const,
    code: source?.code ?? 'E_MATERIAL_GRAPH_COMPILE',
    message: source?.message ?? (error instanceof Error ? error.message : String(error)),
    ...(source?.path === undefined ? {} : { path: source.path }),
    ...(source?.details === undefined ? {} : { details: source.details }),
  });
}

export type { MaterialGraphNodeDescriptorV1, MaterialGraphNodePortV1 } from './graph/nodeRegistry';
export type {
  ShaderGraphLiteralValueV1 as MaterialGraphLiteralValueV1,
  ShaderGraphNodeV1 as MaterialGraphNodeV1,
  ShaderGraphResourceV1 as MaterialGraphResourceV1,
  ShaderGraphValueV1 as MaterialGraphValueV1,
} from './graph/contracts';
