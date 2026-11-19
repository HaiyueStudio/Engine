import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = resolve(process.argv[2]);
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const load = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = async (file, algorithm = 'sha256', format = 'hex') =>
  createHash(algorithm).update(await readFile(file)).digest(format);
const run = (args, cwd) => execFileSync(process.execPath, args, { cwd, encoding: 'utf8' });
const { packages } = await load(join(output, 'packages.json'));
const { publicSurface } = await load(join(repository, 'config/visual-novel-024-contract.json'));
const bytes = {};
const reports = {};

async function* files(root, prefix = '') {
  for (const file of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, file.name);
    if (file.isDirectory()) yield* files(root, path);
    else {
      assert(file.isFile(), 'Unexpected link in the package: ' + path);
      yield path;
    }
  }
}
const published = join(output, 'unpacked-verification');
await mkdir(published);
const declarations = "import { createVisualNovel, validateVisualNovelDefinition } from '" + publicSurface.entry + "';\n" +
  "import type { " + publicSurface.types.join(', ') + " } from '" + publicSurface.entry + "';\n" +
  'export const create: (options: VisualNovelOptions) => VisualNovelSession = createVisualNovel;\n' +
  'export const validate: (definition: VisualNovelDefinition) => VisualNovelDefinition = validateVisualNovelDefinition;\n' +
  'export type StoryState = [VisualNovelSnapshot, VisualNovelView];\n';
const probe = "const entry = await import('./public-entry.mjs');\n" +
  'console.log(JSON.stringify({keys:Object.keys(entry).sort(), path:import.meta.resolve(' + JSON.stringify(publicSurface.entry) + ')}));';

for (const item of packages) {
  const archive = join(output, 'consumer/vendor', item.filename);
  assert.equal(await hash(archive), item.sha256);
  const extract = join(published, item.filename);
  await mkdir(extract);
  execFileSync('tar', ['-xf', archive, '-C', extract]);
  const unpacked = join(extract, 'package');
  bytes[item.name] = {};
  for await (const path of files(unpacked)) bytes[item.name][path] = await hash(join(unpacked, path));
}
for (const variant of ['blank', 'edited']) {
  const consumer = join(output, variant);
  const lock = await load(join(consumer, 'package-lock.json'));
  const retained = {};
  for (const item of packages) {
    const dist = 'node_modules/' + item.name;
    const installed = join(consumer, dist);
    const archive = join(consumer, 'vendor', item.filename);
    assert.equal(await realpath(installed), installed, 'Expected a regular npm install directory.');
    assert.equal(await hash(archive), item.sha256);
    assert.equal(lock.packages[dist].integrity, 'sha512-' + await hash(archive, 'sha512', 'base64'));
    assert.equal((await load(join(installed, 'package.json'))).version, item.version);
    for (const [path, digest] of Object.entries(bytes[item.name])) assert.equal(await hash(join(installed, path)), digest, dist + '/' + path);
    retained[item.name] = { ...item, verifiedFiles: Object.keys(bytes[item.name]).length };
  }
  await writeFile(join(consumer, 'public-check.mts'), declarations);
  run(['node_modules/typescript/bin/tsc', '--module', 'nodenext', '--target', 'es2022', '--skipLibCheck',
    '--strict', '--noEmit', 'public-check.mts'], consumer);
  const entry = JSON.parse(run(['--input-type=module', '-e', probe], consumer));
  assert.deepEqual(entry.keys, [...publicSurface.functions].sort());
  assert.equal(fileURLToPath(entry.path), join(consumer, 'node_modules/@haiyue/extensions/dist/visual-novel.js'));
  const expected = variant === 'blank' ? ['lantern', 'tide'] : ['relight'];
  const previews = {};
  for (const ending of expected) {
    const data = JSON.parse(run(['tools/author.mjs', 'preview', 'project/story.json', '--route', ending], consumer));
    assert.equal(data.preview.ending, ending);
    previews[ending] = { line: data.preview.lineId, node: data.preview.nodeId, visited: data.preview.visited };
    await writeFile(join(output, ending + '-author-preview.json'), JSON.stringify(data, null, 2) + '\n');
  }
  reports[variant] = { publicFunctions: entry.keys, publicTypes: publicSurface.types, archives: retained,
    lockSha256: await hash(join(consumer, 'package-lock.json')), bundleSha256: await hash(join(consumer, 'dist/bundle.js')), previews };
}
assert.equal(reports.blank.lockSha256, reports.edited.lockSha256);
assert.equal(reports.blank.bundleSha256, reports.edited.bundleSha256, 'Editing project data should not change the engine bundle.');
const kit = { filename: 'last-lantern-kit.tar.gz', sha256: await hash(join(output, 'last-lantern-kit.tar.gz')) };
await writeFile(join(output, 'independent-installs.json'), JSON.stringify({ status: 'passed', kit, reports }, null, 2) + '\n');
console.log(JSON.stringify({ status: 'passed', kit, archives: packages.length, independentInstalls: Object.keys(reports) }));
