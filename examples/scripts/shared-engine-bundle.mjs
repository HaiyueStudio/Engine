import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SHARED_ENGINE_TARGET = 'shared-engine';
export const SHARED_ENGINE_INPUT = '\0haiyue-example-shared-engine';
export const SHARED_ENGINE_OUTPUT = 'shared/engine.js';
export const SHARED_ENGINE_GLOBAL = 'HaiyueExampleEngine';

const enginePackage = JSON.parse(
  readFileSync(new URL('../../engine/package.json', import.meta.url), 'utf8'),
);

export const sharedEngineEntrypoints = Object.freeze(
  Object.keys(enginePackage.exports).map((exportPath, index) => {
    const exportDescriptor = enginePackage.exports[exportPath];
    const packageId = exportPath === '.'
      ? enginePackage.name
      : `${enginePackage.name}/${exportPath.slice(2)}`;
    const property = exportPath === '.'
      ? 'root'
      : `entry${index}_${exportPath.slice(2).replace(/[^A-Za-z0-9_$]/g, '_')}`;
    const sourcePath = exportDescriptor.import
      .replace(/^\.\/dist\//u, './src/')
      .replace(/\.js$/u, '.ts');
    const input = fileURLToPath(new URL(`../../engine/${sourcePath}`, import.meta.url));
    return Object.freeze({ exportPath, packageId, property, input });
  }),
);

export const sharedEngineLocalPackages = Object.freeze(Object.fromEntries(
  sharedEngineEntrypoints.map(entry => [entry.packageId, entry.input]),
));

const engineGlobals = new Map(
  sharedEngineEntrypoints.map(entry => [
    entry.packageId,
    `${SHARED_ENGINE_GLOBAL}.${entry.property}`,
  ]),
);

export function isSharedEngineImport(id) {
  return engineGlobals.has(id);
}

export function sharedEngineGlobal(id) {
  return engineGlobals.get(id);
}

export function sharedEngineEntryPlugin() {
  return {
    name: 'haiyue-example-shared-engine-entry',
    resolveId(id) {
      return id === SHARED_ENGINE_INPUT ? id : null;
    },
    load(id) {
      if (id !== SHARED_ENGINE_INPUT) return null;
      const imports = sharedEngineEntrypoints.map((entry, index) => (
        `import * as module${index} from ${JSON.stringify(entry.packageId)};`
      ));
      const properties = sharedEngineEntrypoints.map((entry, index) => (
        `  ${JSON.stringify(entry.property)}: module${index},`
      ));
      return [
        ...imports,
        '',
        `globalThis.${SHARED_ENGINE_GLOBAL} = Object.freeze({`,
        ...properties,
        '});',
      ].join('\n');
    },
  };
}
