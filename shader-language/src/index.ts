export {
  SHADER_CAPABILITY_PROFILES,
  SHADER_COLOR_SPACES,
  SHADER_COORDINATE_SPACES,
  SHADER_RESOURCE_GROUPS,
  SHADER_RESOURCE_SPACES,
  SHADER_STAGES,
  SHADER_TARGETS,
} from './contracts';
export type {
  ComposeShaderModulesOptions,
  ComposedShaderModules,
  ShaderCapabilityProfile,
  ShaderColorSpace,
  ShaderCoordinateSpace,
  ShaderDiagnostic,
  ShaderDiagnosticCode,
  ShaderEntryPointDefinition,
  ShaderGeneratedSource,
  ShaderGeneratedSourceSpan,
  ShaderModule,
  ShaderModuleDefinition,
  ShaderReflection,
  ShaderResourceDefinition,
  ShaderResourceKind,
  ShaderResourceReflection,
  ShaderResourceSpace,
  ShaderSourceContext,
  ShaderSourceFactory,
  ShaderSourceLocation,
  ShaderSourceSpan,
  ShaderSpecializationDefinition,
  ShaderSpecializationType,
  ShaderSpecializationValue,
  ShaderStage,
  ShaderSymbolDefinition,
  ShaderSymbolImportDefinition,
  ShaderTarget,
  ShaderUniformBlockReflection,
  ShaderUniformFieldDefinition,
  ShaderUniformFieldReflection,
  ShaderVaryingReflection,
} from './contracts';
export {
  composeShaderModules,
  formatShaderCompilationMessage,
  mapShaderSourceLocation,
} from './composer';
export { ShaderComposerError } from './diagnostics';
export { sha256Hex } from './hash';
export { defineShaderModule } from './module';
export {
  SHADER_IR_SCALAR_TYPES,
  genericShaderIrType,
  parseShaderIrDataType,
  shaderIrValueTypeKey,
  shaderIrValueTypesEqual,
  shaderValueType,
} from './ir/types';
export type {
  ShaderIrDataType,
  ShaderIrDataTypeInfo,
  ShaderIrMatrixType,
  ShaderIrScalarType,
  ShaderIrSemantic,
  ShaderIrValueType,
  ShaderIrValueTypeDefinition,
  ShaderIrVectorType,
  ShaderIrVectorWidth,
} from './ir/types';
export type {
  ShaderIrBuilder,
  ShaderIrEntry,
  ShaderIrEntryDefinition,
  ShaderIrEntryInput,
  ShaderIrEntryInputBuiltin,
  ShaderIrEntryInputDefinition,
  ShaderIrEntryOutput,
  ShaderIrEntryOutputBuiltin,
  ShaderIrEntryOutputDefinition,
  ShaderIrInterpolation,
  ShaderIrNode,
  ShaderIrNodeOperation,
  ShaderIrProgram,
  ShaderIrProgramDefinition,
  ShaderIrSource,
  ShaderIrTextureSampleOptions,
  ShaderIrValue,
} from './ir/contracts';
export { createShaderIrCanonicalForm, computeShaderIrCanonicalHash } from './ir/canonical';
export { optimizeShaderIrProgram, shaderIrOperationHasImplicitState } from './ir/optimizer';
export type { OptimizedShaderIrProgram, ShaderIrOptimizationReport } from './ir/optimizer';
export { defineShaderIrProgram } from './ir/program';
export { validateShaderIrProgram } from './ir/validator';
export { compileShaderIrProgramToWgsl } from './backend/wgsl';
export type { ShaderIrWgslCompilation, ShaderIrWgslResourceResolver } from './backend/wgsl';
export type {
  ShaderCompilationCostEvidence,
  ShaderCompilationCostOptions,
  ShaderCompilationPhaseTimings,
} from './backend/compilationCost';
export { compileShaderIrProgramToGlslEs300, mapGlslEs300SourceLocation } from './backend/glslEs300';
export type {
  ShaderIrGlslEs300Compilation,
  ShaderIrGlslEs300EntryCompilation,
  ShaderIrGlslEs300Options,
  ShaderIrGlslEs300SampledTexture,
  ShaderIrGlslEs300UniformBlock,
} from './backend/glslEs300';
export { defineTypedShaderModule } from './typedModule';
export type { TypedShaderModule, TypedShaderModuleDefinition } from './typedModule';
export { parseShaderGraphV1 } from './graph/parser';
export {
  SHADER_GRAPH_V1_OPTIONAL_ROOT_FIELDS,
  SHADER_GRAPH_V1_REQUIRED_ROOT_FIELDS,
  SHADER_GRAPH_V1_ROOT_FIELDS,
  SHADER_GRAPH_V1_UNSUPPORTED_ROOT_FIELDS,
} from './graph/contracts';
export type {
  ParseShaderGraphV1Options,
  ShaderGraphKind,
  ShaderGraphLiteralValueV1,
  ShaderGraphNodeV1,
  ShaderGraphNodeValueV1,
  ShaderGraphResourceFrequency,
  ShaderGraphResourceKind,
  ShaderGraphResourceV1,
  ShaderGraphResourceValueV1,
  ShaderGraphSemanticValueV1,
  ShaderGraphSourceLocation,
  ShaderGraphV1,
  ShaderGraphValueV1,
} from './graph/contracts';
export {
  PBR_PILOT_VARIANT_POLICY,
  compileMaterialGraphV1,
} from './graph/materialCompiler';
export type {
  CompileMaterialGraphV1Options,
  CompiledMaterialGraphV1,
} from './graph/materialCompiler';
export {
  MATERIAL_SURFACE_V1_SLOTS,
  MATERIAL_SURFACE_V1_TYPES,
} from './material/surface';
export type {
  MaterialSurfaceV1Slot,
  MaterialSurfaceV1Values,
} from './material/surface';
export {
  METALLIC_ROUGHNESS_PBR_V1_SURFACE_SUPPORT,
} from './material/pbr';
export {
  DEFORMATION_PASS_KINDS,
} from './deformation/contracts';
export type {
  CompiledDeformationPassFamilyV1,
  CompiledDeformationPassV1,
  DeformationHistoryAudit,
  DeformationHistorySample,
  DeformationHistorySnapshot,
  DeformationHistoryState,
  DeformationIrNode,
  DeformationIrOperation,
  DeformationPassKind,
  DeformationPassReflection,
  DeformationProgramV1,
  DeformationProgramV1Definition,
  DeformationVertexAttributeReflection,
  DeformationVertexFormat,
  NormalSineDisplacementV1,
} from './deformation/contracts';
export { defineDeformationProgramV1 } from './deformation/program';
export { compileDeformationPassFamilyV1 } from './deformation/wgsl';
export { DeformationHistoryTracker } from './deformation/history';
export { PRODUCTION_DEFORMATION_OPERATIONS } from './deformation/production-contracts';
export type {
  CompileProductionDeformationFamilyV1Options,
  CompiledProductionDeformationFamilyV1,
  CompiledProductionDeformationPassV1,
  ProductionDeformationFamilyPassV1,
  ProductionDeformationFamilyV1,
  ProductionDeformationOperation,
} from './deformation/production-contracts';
export { compileProductionDeformationFamilyV1 } from './deformation/production-family';
export { PRODUCTION_MATERIAL_LIGHTING_OPERATIONS } from './material-lighting/contracts';
export type {
  CompileProductionMaterialLightingFamilyV1Options,
  CompiledProductionMaterialLightingFamilyV1,
  CompiledProductionMaterialLightingPassV1,
  ProductionMaterialLightingFamilyPassV1,
  ProductionMaterialLightingFamilyV1,
  ProductionMaterialLightingOperation,
} from './material-lighting/contracts';
export { compileProductionMaterialLightingFamilyV1 } from './material-lighting/family';
export { PRODUCTION_SPECIALIZED_RENDERING_OPERATIONS } from './specialized-rendering/contracts';
export type {
  CompileProductionSpecializedRenderingFamilyV1Options,
  CompiledProductionSpecializedRenderingFamilyV1,
  CompiledProductionSpecializedRenderingPassV1,
  ProductionSpecializedRenderingFamilyPassV1,
  ProductionSpecializedRenderingFamilyV1,
  ProductionSpecializedRenderingOperation,
} from './specialized-rendering/contracts';
export { compileProductionSpecializedRenderingFamilyV1 } from './specialized-rendering/family';
export { PRODUCTION_COMPUTE_OPERATIONS } from './compute/contracts';
export type {
  CompileProductionComputeFamilyV1Options,
  CompiledProductionComputeFamilyV1,
  CompiledProductionComputePassV1,
  ComputeDispatchDomainV1,
  ComputeDispatchIrV1,
  ComputeDispatchScheduleV1,
  ComputeEffectIrV1,
  ComputeEffectKindV1,
  ComputeResourceAccessV1,
  ComputeResourceIrV1,
  ComputeResourceKindV1,
  ProductionComputeFamilyV1,
  ProductionComputeOperation,
  ProductionComputePassIrV1,
} from './compute/contracts';
export { compileProductionComputeFamilyV1 } from './compute/family';
export {
  MOTION_BLUR_POSTPROCESS_PASSES,
} from './postprocess/contracts';
export type {
  CompileMotionBlurPostProcessV1Options,
  CompileMotionBlurGraphV1Options,
  CompiledMotionBlurGraphV1,
  CompiledMotionBlurPassV1,
  CompiledMotionBlurPostProcessV1,
  MotionBlurDisplayMode,
  MotionBlurPassPlan,
  MotionBlurPassReflection,
  MotionBlurPostProcessIrNode,
  MotionBlurPostProcessIrOperation,
  MotionBlurPostProcessPass,
  MotionBlurPostProcessProgramV1,
  MotionBlurPostProcessProgramV1Definition,
  MotionBlurPostProcessResourceIds,
  MotionBlurReconstructionMode,
  MotionBlurVariantPolicy,
} from './postprocess/contracts';
export { defineMotionBlurPostProcessProgramV1 } from './postprocess/program';
export { compileMotionBlurPostProcessV1 } from './postprocess/wgsl';
export { compileMotionBlurGraphV1 } from './postprocess/graph';
export { BUILTIN_POSTPROCESS_OPERATIONS } from './postprocess/builtin-contracts';
export type {
  BuiltinPostprocessFamilyV1,
  BuiltinPostprocessOperation,
  BuiltinPostprocessPassV1,
  CompileBuiltinPostprocessFamilyV1Options,
  CompiledBuiltinPostprocessFamilyV1,
  CompiledBuiltinPostprocessPassV1,
} from './postprocess/builtin-contracts';
export { compileBuiltinPostprocessFamilyV1 } from './postprocess/builtin-family';
export {
  BUILTIN_RENDER_FAMILY_KINDS,
  BUILTIN_RENDER_OPERATIONS,
} from './render-family/contracts';
export type {
  BuiltinRenderFamilyKind,
  BuiltinRenderFamilyPassV1,
  BuiltinRenderFamilyV1,
  BuiltinRenderOperation,
  CompileBuiltinRenderFamilyV1Options,
  CompiledBuiltinRenderFamilyV1,
  CompiledBuiltinRenderPassV1,
} from './render-family/contracts';
export { compileBuiltinRenderFamilyV1 } from './render-family/family';
export { createMotionBlurPrecompiledArtifactV2 } from './adapter/precompiled';
export type { MotionBlurPrecompiledArtifactOptions } from './adapter/precompiled';
export { createPrecompiledShaderArtifactV2 } from './adapter/precompiled-v2';
export type {
  PrecompiledShaderArtifactV2,
  PrecompiledShaderArtifactV2Definition,
  PrecompiledShaderBindingLayoutV2,
  PrecompiledShaderBindingV2,
  PrecompiledShaderBindGroupV2,
  PrecompiledShaderLayoutOwnerV2,
  PrecompiledShaderPassV2,
  PrecompiledShaderPassV2Definition,
  PrecompiledShaderRenderTargetV2,
  PrecompiledShaderSourceMapEntryV2,
  PrecompiledShaderStage,
  PrecompiledShaderStageEntriesV2,
  PrecompiledShaderUniformBlockV2,
  PrecompiledShaderUniformFieldV2,
  PrecompiledShaderVaryingV2,
  PrecompiledShaderVertexAttributeV2,
  PrecompiledShaderVertexBufferV2,
} from './adapter/precompiled-v2';
export { packShaderUniformBlock } from './uniformPacker';
export type { ShaderUniformValue } from './uniformPacker';
