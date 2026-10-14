import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_REPOSITORIES, requireStudioRepository } from './studio-repository-layout.mjs';
import { validateReviewArchive } from './review-archive-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = resolve(root, 'docs');
const studio = process.argv.includes('--studio');
const documentationRoots = Object.values(STUDIO_REPOSITORIES).map(repository => repository.root);
const violations = [];
const expectedRootEntries = new Set([
  'AGENTS.md',
  'README.md',
  'api',
  'editor-guide',
  'engine-guide',
  'for-ai',
]);

for (const entry of readdirSync(docsRoot, { withFileTypes: true })) {
  if (!expectedRootEntries.has(entry.name)) {
    violations.push(`docs root contains an unclassified entry: docs/${entry.name}`);
  }
}

for (const path of [
  'docs/README.md',
  'docs/api/README.md',
  'docs/editor-guide/README.md',
  'docs/engine-guide/README.md',
  'docs/for-ai/README.md',
  'docs/for-ai/documentation-conventions.md',
]) {
  requireFile(path);
}

for (const absolute of walkMarkdown(docsRoot)) validateMarkdownLinks(absolute);
for (const directory of ['review/engine-0.2.1', 'review/archive']) {
  for (const absolute of walkMarkdown(resolve(root, directory))) validateMarkdownLinks(absolute);
}
validateMarkdownLinks(resolve(root, 'README.md'));
for (const entry of readdirSync(resolve(root, 'review/archive'))) {
  if (!entry.endsWith('.json')) continue;
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, 'review/archive', entry), 'utf8'));
    if (!/^[a-z0-9-]+\.zip$/.test(manifest.archive ?? '')) throw Error('Unsafe archive name');
    validateReviewArchive(manifest, readFileSync(resolve(root, 'review/archive', manifest.archive)));
  } catch (error) { violations.push(`review/archive/${entry}: ${error.message}`); }
}

for (const absolute of walkSources([
  resolve(root, 'engine/src'),
  resolve(root, 'extensions/src'),
  ...(studio ? [resolve(requireStudioRepository('Editor').root, 'editor/src')] : []),
])) {
  const source = readFileSync(absolute, 'utf8');
  for (const match of source.matchAll(/docsPath:\s*['"]([^'"]+)['"]/g)) {
    requireFile(`docs/api/${match[1]}.md`);
  }
}

if (violations.length > 0) {
  console.error('[docs] Structure or link violations:');
  for (const violation of [...new Set(violations)].sort()) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('[docs] Four audience sections, relative links, and API error mappings passed.');

function validateMarkdownLinks(absolute) {
  if (!existsSync(absolute)) return;
  const source = readFileSync(absolute, 'utf8');
  const relativeSource = relative(root, absolute);

  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const destination = normalizeDestination(match[1]);
    if (!destination || /^(?:[a-z][a-z\d+.-]*:|#)/i.test(destination)) continue;

    const withoutFragment = destination.split('#', 1)[0].split('?', 1)[0];
    if (!withoutFragment) continue;

    let decoded;
    try {
      decoded = decodeURIComponent(withoutFragment);
    } catch {
      violations.push(`${relativeSource} contains an invalid encoded link: ${destination}`);
      continue;
    }

    const target = resolve(dirname(absolute), decoded);
    if (!isInsideDocumentationRoots(target)) {
      violations.push(`${relativeSource} links outside the HaiyueStudio repositories: ${destination}`);
    } else if ((studio || target === root || target.startsWith(root + sep)) && !existsSync(target)) {
      violations.push(`${relativeSource} has a broken link: ${destination}`);
    }
  }
}

function normalizeDestination(raw) {
  const value = raw.trim();
  if (value.startsWith('<')) {
    const closing = value.indexOf('>');
    return closing < 0 ? value : value.slice(1, closing);
  }
  return value.split(/\s+/, 1)[0];
}

function isInsideDocumentationRoots(path) {
  return documentationRoots.some(repositoryRoot => {
    const pathFromRoot = relative(repositoryRoot, path);
    return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..');
  });
}

function walkMarkdown(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkMarkdown(absolute));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(absolute);
  }
  return result;
}

function walkSources(directories) {
  const result = [];
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) result.push(...walkSources([absolute]));
      else if (entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name)) result.push(absolute);
    }
  }
  return result;
}

function requireFile(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) violations.push(`missing ${path}`);
}
