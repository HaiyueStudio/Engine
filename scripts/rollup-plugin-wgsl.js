import { readFile } from 'node:fs/promises';

export function wgslRaw() {
  return {
    name: 'wgsl-raw',
    async load(id) {
      if (!id.endsWith('.wgsl')) return null;
      const source = await readFile(id, 'utf8');
      return {
        code: `export default ${JSON.stringify(source)};`,
        map: { mappings: '' },
      };
    },
  };
}

export default wgslRaw;
