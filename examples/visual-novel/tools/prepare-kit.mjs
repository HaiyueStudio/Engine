import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { npmArgs, npmCommand, parseNpmPackManifest } from '../../../scripts/npm-process.mjs';

const example = fileURLToPath(new URL('../', import.meta.url));
const repository = resolve(example, '../..');
const id = process.argv[2];
assert.match(id ?? '', /^[a-z0-9][a-z0-9-]{0,63}$/u, 'Supply a unique evidence directory name.');
const output = join(repository, 'artifacts/engine-0.2.4/g06', id);
const consumer = join(output, 'consumer');
const vendor = join(consumer, 'vendor');
const compiled = join(output, 'compiled');
const version = '0.2.4-g06.0';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const node = (args, cwd = repository) => execFileSync(process.execPath, args, { cwd, stdio: 'inherit' });
const tar = args => execFileSync('tar', args, { cwd: repository, stdio: 'inherit' });

const aliases = {
  'g06:audio': 'audio.js',
  'g06:reader-audio': 'visual-novel/audio/ReadingAudio.js',
  'g06:save': 'visual-novel/save/VisualNovelSaveSession.js',
  'g06:scene': 'visual-novel/save/scene-presentation.js',
  'g06:stage': 'visual-novel/stage/hya-stage.js',
  'g06:reading': 'visual-novel/ui/GuiReading.js',
  'g06:compile': 'visual-novel/story/compile.js',
  'g06:data': 'visual-novel/story/data.js',
  'g06:preview': 'visual-novel/story/preview.js',
};
const authoring = join(repository, 'scripts/visual-novel-authoring');
async function bundle(input, file) {
  const result = await rollup({
    input, external: name => name.startsWith('@haiyue/') || name.startsWith('node:') || name === 'typescript',
    plugins: [{
      name: 'visual-novel-candidate',
      resolveId(specifier, importer) {
        if (Object.hasOwn(aliases, specifier)) return join(compiled, aliases[specifier]);
        if (specifier === '../../hya-player.js' && importer === join(compiled, aliases['g06:stage'])) {
          return { id: '@haiyue/extensions/hya-player', external: true };
        }
      },
      transform(source, filename) {
        if (filename !== join(authoring, 'project.mjs')) return;
        const first = source.indexOf("register('./source-loader.mjs'");
        const last = source.indexOf('const extensions =');
        assert(first >= 0 && last > first, 'The author CLI source loader changed.');
        return source.slice(0, first).replace("import { register } from 'node:module';", '') +
          "import { compileStory } from 'g06:compile';\n" +
          "import { fields, items, relativeFile, StoryDataError } from 'g06:data';\n" +
          "import { previewStory, StoryPreviewError } from 'g06:preview';\n\n" + source.slice(last);
      },
    }, nodeResolve()],
    onwarn(warning, handle) {
      if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(warning.message);
      handle(warning);
    },
  });
  try { await result.write({ file, format: 'es', inlineDynamicImports: true }); }
  finally { await result.close(); }
}

await mkdir(join(output, '..'), { recursive: true });
await mkdir(output);
await mkdir(vendor, { recursive: true });
await mkdir(join(consumer, 'tools'));
node([join(repository, 'node_modules/typescript/bin/tsc'), '-p', join(example, 'tools/tsconfig.json'), '--outDir', compiled]);
for (const entry of ['index.html', 'style.css', 'main.mjs', 'project']) {
  await cp(join(example, entry), join(consumer, entry), { recursive: true });
}
for (const entry of ['build.mjs', 'serve.mjs', 'create-art.mjs', 'create-audio.mjs']) {
  await cp(join(example, 'tools', entry), join(consumer, 'tools', entry));
}
await cp(join(repository, 'LICENSE'), join(consumer, 'LICENSE'));
await cp(join(repository, 'docs/engine-guide/visual-novel.md'), join(consumer, 'README.md'));
await cp(join(repository, 'scripts/fixtures/engine-consumers/extensions-visual-novel.mjs'), join(consumer, 'public-entry.mjs'));
await bundle(join(authoring, 'cli.mjs'), join(consumer, 'tools/author.mjs'));

const artifacts = join(repository, 'artifacts/engine-0.2.4');
const { packages: basePackages } = await json(join(artifacts, 'g04/npm12-package-final/public-packages.json'));
const registryEvidence = join(artifacts, 'g01/consumer');
const { packages: frozenPackages } = await json(join(registryEvidence, 'package-provenance.json'));
const dependencies = {};
const packages = [];
for (const name of ['@haiyue/engine', '@haiyue/extensions']) {
  const original = basePackages.find(pkg => pkg.name === name);
  const base = join(repository, original.artifact);
  assert.equal(await sha256(base), original.sha256, name);
  const unpacked = join(output, 'stage', original.workspace);
  await mkdir(unpacked, { recursive: true });
  tar(['-xf', base, '-C', unpacked]);
  const cwd = join(unpacked, 'package');
  const manifestPath = join(cwd, 'package.json');
  const manifest = await json(manifestPath);
  manifest.version = version;
  manifest.private = true;
  delete manifest.publishConfig;
  if (name === '@haiyue/extensions') {
    manifest.peerDependencies['@haiyue/engine'] = version;
    manifest.exports['./visual-novel'] = { types: './dist/visual-novel.d.ts', import: './dist/visual-novel.js' };
    await bundle(join(example, 'tools/candidate-entry.mjs'), join(cwd, 'dist/visual-novel.js'));
    await cp(join(example, 'tools/candidate-api.d.ts'), join(cwd, 'dist/visual-novel.d.ts'));
  }
  await save(manifestPath, manifest);
  const manifestJson = execFileSync(npmCommand(), npmArgs([
    'pack', '--offline', '--ignore-scripts', '--json', '--cache', join(output, 'npm-pack-cache'), '--pack-destination', vendor,
  ]), { cwd, encoding: 'utf8' });
  const { filename } = parseNpmPackManifest(manifestJson, name);
  dependencies[name] = 'file:vendor/' + filename;
  packages.push({ name, version, filename, sha256: await sha256(join(vendor, filename)), baseSha256: original.sha256 });
}
for (const name of ['@haiyue/animation-spec', '@haiyue/shader-language']) {
  const frozen = frozenPackages.find(pkg => pkg.package === name);
  const original = join(registryEvidence, frozen.path);
  assert.equal(await sha256(original), frozen.sha256, name);
  const filename = basename(original);
  await cp(original, join(vendor, filename));
  dependencies[name] = 'file:vendor/' + filename;
  packages.push({ name, version: frozen.version, filename, sha256: frozen.sha256 });
}
const devDependencies = {
  '@rollup/plugin-commonjs': '29.0.3',
  '@rollup/plugin-node-resolve': '15.3.1',
  rollup: '4.62.4',
  typescript: (await json(join(repository, 'node_modules/typescript/package.json'))).version,
};
await save(join(consumer, 'package.json'), {
  name: 'last-lantern-visual-novel', private: true, type: 'module', version: '1.0.0', license: 'MIT',
  engines: { node: '>=22' }, scripts: { build: 'node tools/build.mjs', start: 'node tools/serve.mjs' },
  dependencies, devDependencies,
});
await save(join(output, 'packages.json'), { status: 'local-g06-candidate', packages });
console.log(consumer);
