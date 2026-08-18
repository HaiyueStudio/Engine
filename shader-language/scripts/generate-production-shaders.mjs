import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkShaderMigrationManifest } from './check-migration-manifest.mjs';
import { generateRuntimeArtifactContract } from './generate-runtime-artifact-contract.mjs';
import {
  formatMotionBlurGenerationResult,
  generateMotionBlurProduction,
} from './generate-motion-blur-production.mjs';
import {
  formatBuiltinPostprocessGenerationResult,
  generateBuiltinPostprocessProduction,
} from './generate-builtin-postprocess-production.mjs';
import {
  formatBuiltinRenderGenerationResult,
  generateBuiltinRenderProduction,
} from './generate-builtin-render-production.mjs';
import {
  formatDeformationGenerationResult,
  generateDeformationProduction,
} from './generate-deformation-production.mjs';
import {
  formatMaterialLightingGenerationResult,
  generateMaterialLightingProduction,
} from './generate-material-lighting-production.mjs';
import {
  formatSpecializedRenderingGenerationResult,
  generateSpecializedRenderingProduction,
} from './generate-specialized-rendering-production.mjs';
import {
  formatComputeGenerationResult,
  generateComputeProduction,
} from './generate-compute-production.mjs';

export const PRODUCTION_SHADER_GENERATORS = Object.freeze([
  Object.freeze({
    id: 'motion-blur',
    artifactVersion: 2,
    run: generateMotionBlurProduction,
    format: formatMotionBlurGenerationResult,
  }),
  Object.freeze({
    id: 'builtin-postprocess',
    artifactVersion: 2,
    run: generateBuiltinPostprocessProduction,
    format: formatBuiltinPostprocessGenerationResult,
  }),
  Object.freeze({
    id: 'builtin-render',
    artifactVersion: 2,
    run: generateBuiltinRenderProduction,
    format: formatBuiltinRenderGenerationResult,
  }),
  Object.freeze({
    id: 'deformation',
    artifactVersion: 2,
    run: generateDeformationProduction,
    format: formatDeformationGenerationResult,
  }),
  Object.freeze({
    id: 'material-lighting',
    artifactVersion: 2,
    run: generateMaterialLightingProduction,
    format: formatMaterialLightingGenerationResult,
  }),
  Object.freeze({
    id: 'specialized-rendering',
    artifactVersion: 2,
    run: generateSpecializedRenderingProduction,
    format: formatSpecializedRenderingGenerationResult,
  }),
  Object.freeze({
    id: 'compute',
    artifactVersion: 2,
    run: generateComputeProduction,
    format: formatComputeGenerationResult,
  }),
]);

export async function generateProductionShaders({ write = false, only } = {}) {
  await generateRuntimeArtifactContract({ write });
  const manifest = await checkShaderMigrationManifest();
  const selected = only
    ? PRODUCTION_SHADER_GENERATORS.filter(generator => generator.id === only)
    : PRODUCTION_SHADER_GENERATORS;
  if (selected.length === 0) throw new Error(`Unknown production shader generator ${only}.`);
  const results = [];
  for (const generator of selected) {
    const result = await generator.run({ write });
    results.push(result);
    console.log(generator.format(result, write));
  }
  console.log(`[shader-language:production] ${write ? 'wrote' : 'verified'} ${results.length} registered generator(s); migration inventory=${manifest.wgslSourceCount}.`);
  return Object.freeze(results);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write');
  const onlyArgument = process.argv.find(argument => argument.startsWith('--only='));
  await generateProductionShaders({ write, only: onlyArgument?.slice('--only='.length) });
}
