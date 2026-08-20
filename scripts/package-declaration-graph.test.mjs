import test from 'node:test';
import assert from 'node:assert/strict';
import { collectReachablePackageDeclarations } from './package-declaration-graph.mjs';

test('public declaration graph retains recursive types and omits compiler-only files', () => {
  const reachable = collectReachablePackageDeclarations({
    packageJson: {
      types: './dist/index.d.ts',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './ray-tracing': { types: './dist/ray-tracing.d.ts', import: './dist/ray-tracing.js' },
      },
    },
    declarations: {
      'dist/index.d.ts': "export type { EngineType } from './internal/engine.js';",
      'dist/internal/engine.d.ts': 'export interface EngineType { readonly id: string; }',
      'dist/ray-tracing.d.ts': "export * as rayScene from './ray/scene/index.js';",
      'dist/ray/scene/index.d.ts': "export type { RayScene } from './types.js';",
      'dist/ray/scene/types.d.ts': 'export interface RayScene { readonly revision: number; }',
      'dist/compiler-only.d.ts': 'export interface CompilerOnly {}',
    },
  });

  assert.deepEqual([...reachable].sort(), [
    'dist/index.d.ts',
    'dist/internal/engine.d.ts',
    'dist/ray-tracing.d.ts',
    'dist/ray/scene/index.d.ts',
    'dist/ray/scene/types.d.ts',
  ]);
});

test('declaration graph ignores package imports and missing relative candidates', () => {
  const reachable = collectReachablePackageDeclarations({
    packageJson: { types: 'dist/index.d.ts' },
    declarations: {
      'dist/index.d.ts': "import type { External } from '@haiyue/engine'; export type Local = import('./missing.js').Missing | External;",
      'dist/unrelated.d.ts': 'export interface Unrelated {}',
    },
  });
  assert.deepEqual([...reachable], ['dist/index.d.ts']);
});
