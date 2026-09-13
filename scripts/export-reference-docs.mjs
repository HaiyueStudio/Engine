import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Companion release artifact. API signatures remain owned by the installed declarations. */
export async function collectReferenceDocs(root) {
  const entries = [];
  async function visit(directory) {
    for (const item of (await readdir(path.join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${directory}/${item.name}`;
      if (item.isDirectory()) await visit(relative);
      else if (item.isFile() && item.name.endsWith('.md')) {
        const source = await readFile(path.join(root, relative), 'utf8');
        const text = source.replace(/\]\(([^\s)]+)\)/g, (match, target) => {
          if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return match;
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
          const uri = resolved.startsWith('../') ? `studio-reference:/${resolved.replace(/^(?:\.\.\/)+/, '')}` : `engine-reference:/${resolved}`;
          return `](${uri})`;
        });
        entries.push({ path: relative, sourceDigest: `sha256:${createHash('sha256').update(source).digest('hex')}`, text });
      }
    }
  }
  await visit('docs/api'); await visit('docs/engine-guide');
  return { schemaVersion: 1, entries, contentDigest: `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}` };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  const output = process.argv[2];
  if (!output) throw new Error('Usage: node scripts/export-reference-docs.mjs <output.json>');
  const corpus = await collectReferenceDocs(root);
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const sourceDirty = execFileSync('git', ['status', '--porcelain', '--', 'docs/api', 'docs/engine-guide'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
  const destination = path.resolve(output);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify({ ...corpus, sourceRevision, sourceDirty }, null, 2)}\n`);
  console.log(JSON.stringify({ output: destination, documents: corpus.entries.length, sourceRevision, sourceDirty, contentDigest: corpus.contentDigest }));
}
