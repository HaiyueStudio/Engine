import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import ts from 'typescript';

const ENTRY_ID = '\0haiyue-cubism-framework-evaluator';
const FRAMEWORK_PREFIX = '@haiyue-cubism-framework/';

/**
 * Bundles a caller-supplied official Cubism Web Framework checkout for the
 * isolated build-time capture page. The bundle is temporary and is never
 * copied into HYA output or an npm package.
 */
export async function buildCubismFrameworkEvaluator({ frameworkRoot, output, version }) {
  const sourceRoot = resolve(frameworkRoot, 'src');
  const required = [
    'live2dcubismframework.ts',
    'model/cubismmoc.ts',
    'motion/cubismmotion.ts',
    'motion/cubismexpressionmotion.ts',
    'motion/cubismmotionqueuemanager.ts',
    'physics/cubismphysics.ts',
    'effect/cubismpose.ts',
    'rendering/cubismrenderer.ts',
  ];
  for (const path of required) {
    const absolute = resolve(sourceRoot, path);
    if (!existsSync(absolute)) throw new Error(`Official Cubism Framework source is incomplete: ${absolute}`);
  }

  const importPath = path => JSON.stringify(`${FRAMEWORK_PREFIX}${path}`);
  const entry = [
    `import { CubismFramework } from ${importPath('live2dcubismframework.ts')};`,
    `import { CubismMoc } from ${importPath('model/cubismmoc.ts')};`,
    `import { CubismMotion } from ${importPath('motion/cubismmotion.ts')};`,
    `import { CubismExpressionMotion } from ${importPath('motion/cubismexpressionmotion.ts')};`,
    `import { CubismMotionQueueManager } from ${importPath('motion/cubismmotionqueuemanager.ts')};`,
    `import { CubismPhysics } from ${importPath('physics/cubismphysics.ts')};`,
    `import { CubismPose } from ${importPath('effect/cubismpose.ts')};`,
    `import { CubismRenderer } from ${importPath('rendering/cubismrenderer.ts')};`,
    `globalThis.__HYA_CUBISM_FRAMEWORK__ = Object.freeze({`,
    `  version: ${JSON.stringify(version)}, CubismFramework, CubismMoc, CubismMotion,`,
    `  CubismExpressionMotion, CubismMotionQueueManager, CubismPhysics, CubismPose, CubismRenderer,`,
    `});`,
  ].join('\n');

  const bundle = await rollup({
    input: ENTRY_ID,
    plugins: [
      {
        name: 'haiyue-cubism-framework-entry',
        resolveId(id) {
          if (id === ENTRY_ID) return ENTRY_ID;
          if (id.startsWith(FRAMEWORK_PREFIX)) return resolve(sourceRoot, id.slice(FRAMEWORK_PREFIX.length));
          return null;
        },
        load(id) { return id === ENTRY_ID ? entry : null; },
      },
      nodeResolve({ extensions: ['.mjs', '.js', '.json', '.node', '.ts'] }),
      {
        name: 'haiyue-cubism-framework-typescript',
        transform(code, id) {
          if (!id.endsWith('.ts')) return null;
          return {
            code: ts.transpileModule(code, {
              fileName: id,
              compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: false },
            }).outputText,
            map: null,
          };
        },
      },
    ],
    onwarn(warning, warn) { if (warning.code !== 'CIRCULAR_DEPENDENCY') warn(warning); },
  });
  try {
    await bundle.write({ file: resolve(output), format: 'es', sourcemap: false, inlineDynamicImports: true });
  } finally {
    await bundle.close();
  }
}
