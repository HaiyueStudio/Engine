import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root,'dist');
await mkdir(dist, { recursive:true });
await mkdir(join(dist,'project'), { recursive:true });
execFileSync(process.execPath, [join(root,'tools/author.mjs'), 'compile', join(root,'project/story.json'),
  '--out', join(dist,'project/compiled.json'), '--strict'], { cwd:root, stdio:'inherit' });
await cp(join(root,'project/assets'),join(dist,'project/assets'),{recursive:true});
const html = await readFile(join(root,'index.html'),'utf8');
await writeFile(join(dist,'index.html'),html.replace(/<script src="\.\.\/shared\/engine\.js"><\/script>\r?\n/u,'')
  .replace('<script src="./bundle.js"></script>','<script type="module" src="./bundle.js"></script>'));
await cp(join(root,'style.css'),join(dist,'style.css'));
const bundle = await rollup({ input:join(root,'main.mjs'), plugins:[nodeResolve({browser:true}),commonjs()],
  onwarn(warning, handle) {
    if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(warning.message);
    handle(warning);
  } });
try { await bundle.write({file:join(dist,'bundle.js'),format:'es',inlineDynamicImports:true}); }
finally { await bundle.close(); }
