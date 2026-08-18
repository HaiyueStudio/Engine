export { GltfModelComponent } from './gltf/GltfModelComponent';
export type { GltfModelComponentOptions, GltfModelStatus } from './gltf/GltfModelComponent';
export { GltfModelSystem } from './gltf/GltfModelSystem';
export type { GltfModelSystemOptions } from './gltf/GltfModelSystem';
export { applyGltfAnimationClip, disposeGltfModel, GLTF_EXTENSION_CAPABILITIES, loadGltfModel, setGltfMaterialVariant } from './gltf/gltfLoader';
export {
  DEFAULT_GLTF_EXTENSION_ADAPTERS,
  collectGltfMaterialExtensionPatches,
  collectGltfMaterialVariantNames,
  collectGltfMaterialVariantReferences,
  resolveGltfExtensionAdapters,
} from './gltf/GltfExtensionAdapter';
export { encodeGltfPbrMaterial } from './gltf/GltfMaterialEncoder';
export type {
  EncodedGltfPbrMaterial,
  EncodeGltfPbrMaterialOptions,
} from './gltf/GltfMaterialEncoder';
export type {
  DracoDecoderConfig,
  DracoDecoderFactory,
  DracoDecoderModule,
  GltfAssetWorker,
  GltfAnimationClip,
  GltfAnimationInfo,
  GltfAnimationInterpolation,
  GltfAnimationPath,
  GltfAssetStats,
  GltfExtensionCapability,
  GltfExtensionAdapter,
  GltfExtensionReport,
  GltfExtensionReportEntry,
  GltfExtensionSupport,
  GltfLoadWarning,
  GltfCompatibilityExtensionEntry,
  GltfCompatibilityIssue,
  GltfCompatibilityPerformanceSummary,
  GltfCompatibilityReport,
  GltfCompatibilityStatus,
  GltfPrimitiveBoundsCompatibilityEntry,
  GltfPrimitiveBoundsSupport,
  GltfPrimitiveUvSemanticCompatibilityEntry,
  GltfTextureCompatibilityEntry,
  GltfTextureMipmapSource,
  LoadedGltfModel,
  LoadGltfOptions,
} from './gltf/gltfLoader';
export type {
  GltfMaterialExtensionContext,
  GltfMaterialExtensionPatch,
  GltfMaterialStatePatch,
  GltfMaterialTextureBinding,
  GltfMaterialVariantReference,
  GltfPrimitiveExtensionContext,
} from './gltf/GltfExtensionAdapter';
export { createGltfPlugin } from './gltf/GltfPlugin';
export type { GltfPluginOptions } from './gltf/GltfPlugin';
