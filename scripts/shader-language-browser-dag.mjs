/** Browser evidence nodes for Shader Language stages 2–14.
 * Leaf scripts never rebuild prerequisites; the Stage 14 DAG owns build scheduling.
 */
export const SHADER_LANGUAGE_BROWSER_DAG = Object.freeze([
  browserCase(2, ['build:shader-language'], 'scripts/verify-webgpu-shader-language-stage2.mjs'),
  browserCase(3, ['build:shader-language'], 'scripts/verify-webgpu-shader-language-stage3.mjs'),
  browserCase(4, ['build:engine', 'build:extensions'], 'scripts/verify-webgpu-shader-language-stage4.mjs'),
  browserCase(5, ['build:shader-language'], 'scripts/verify-webgpu-shader-language-stage5.mjs'),
  browserCase(6, ['build:motion-blur-example'], 'scripts/verify-motion-blur-example.mjs'),
  browserCase(7, ['build:engine'], 'scripts/verify-webgpu-shader-language-stage7.mjs'),
  browserCase(8, ['build:engine'], 'scripts/verify-webgpu-shader-language-stage8.mjs'),
  browserCase(9, ['build:engine', 'build:extensions'], 'scripts/verify-webgpu-shader-language-stage9.mjs'),
  browserCase(10, ['build:engine'], 'scripts/verify-webgpu-shader-language-stage10.mjs'),
  browserCase(11, ['build:engine'], 'scripts/verify-webgpu-shader-language-stage11.mjs'),
  browserCase(12, ['build:engine'], 'scripts/verify-webgpu-shader-language-stage12.mjs'),
  browserCase(13, ['build:engine'], 'scripts/verify-webgpu-shader-language-stage13.mjs'),
  browserCase(14, ['build:shader-language'], 'scripts/verify-webgpu-shader-language-stage14.mjs'),
]);

function browserCase(stage, dependencies, script) {
  return Object.freeze({
    id: `browser:stage${stage}`,
    stage,
    dependencies: Object.freeze(dependencies),
    script,
  });
}
