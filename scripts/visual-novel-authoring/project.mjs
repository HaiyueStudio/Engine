import { register } from 'node:module';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DEFAULT_HYA_COMPOSITION_LIMITS, parseHyaComposition } from '@haiyue/animation-spec/hya-production';
import { jsonSource } from './json-source.mjs';

register('./source-loader.mjs', import.meta.url);
const storySource = '../../extensions/src/visual-novel/story/';
const [{ compileStory }, { fields, items, relativeFile, StoryDataError }, { previewStory, StoryPreviewError }] =
  await Promise.all(['compile', 'data', 'preview'].map(name => import(`${storySource}${name}.ts`)));

const extensions = {
  hya: new Set(['.hya', '.json']),
  image: new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg']),
  audio: new Set(['.wav', '.mp3', '.ogg', '.opus', '.m4a', '.aac', '.flac', '.caf', '.webm']),
};

function located(documents, diagnostic) {
  const site = documents.get(diagnostic.file)?.locate(diagnostic.path) ?? { line: 1, column: 1 };
  return { ...diagnostic, line: site.line, column: site.column };
}

export async function loadProject(entry) {
  const documents = new Map();
  const files = new Set();
  const diagnostics = [];
  const requested = resolve(entry);
  let projectFile;
  let root;
  let story = null;
  const report = (site, code, message) => diagnostics.push(located(documents, { ...site, severity: 'error', code, message }));
  const catchData = error => {
    if (!(error instanceof StoryDataError)) throw error;
    report(error.source, error.code, error.message);
  };
  const containedFile = async (basePath) => {
    const actual = await realpath(resolve(root, basePath));
    const offset = relative(root, actual);
    if (isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`)) throw new Error('Path resolves outside the project.');
    const info = await stat(actual);
    if (!info.isFile() || !info.size) throw new Error('Expected a nonempty regular file.');
    files.add(actual);
    return { actual, size: info.size };
  };
  const readDocument = async (file, site) => {
    try {
      if (extname(file).toLowerCase() !== '.json') throw new Error('Expected a .json document.');
      const { actual } = await containedFile(file);
      const data = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(actual));
      const parsed = jsonSource(file, data);
      documents.set(file, parsed);
      diagnostics.push(...parsed.diagnostics);
      return parsed;
    } catch (error) {
      report(site, 'unreadable-document', `Cannot read "${file}": ${error.code ?? error.message}`);
    }
  };

  try { projectFile = await realpath(requested); }
  catch (error) {
    report({ file: basename(requested), path: [] }, 'unreadable-project', `Cannot open project: ${error.code ?? error.message}`);
    return { story, diagnostics, files };
  }
  root = dirname(projectFile);
  const projectSite = { file: basename(projectFile), path: [] };
  const project = await readDocument(projectSite.file, projectSite);
  if (!project || diagnostics.length) return { story, diagnostics, files };

  const chapterFiles = new Set();
  const chapters = [];
  const locales = Object.create(null);
  try {
    const { chapters: rawChapters, locales: rawLocales } = fields(project.data, projectSite);
    for (const [index, value] of items(rawChapters, { ...projectSite, path: ['chapters'] }).entries()) {
      const site = { ...projectSite, path: ['chapters', index] };
      try {
        const file = relativeFile(value, site);
        if (chapterFiles.has(file)) report(site, 'duplicate-chapter-file', `Chapter "${file}" is listed twice.`);
        else {
          chapterFiles.add(file);
          const document = await readDocument(file, site);
          if (document) chapters.push(document);
        }
      } catch (error) { catchData(error); }
    }
    for (const [key, value] of Object.entries(fields(rawLocales, { ...projectSite, path: ['locales'] }))) {
      const site = { ...projectSite, path: ['locales', key] };
      try {
        const file = relativeFile(value, site);
        const locale = Intl.getCanonicalLocales(key)[0];
        if (!locale) report(site, 'invalid-locale', `Invalid locale "${key}".`);
        else if (Object.hasOwn(locales, locale)) report(site, 'duplicate-locale', `Locale "${locale}" is listed twice.`);
        else {
          const document = await readDocument(file, site);
          if (document) locales[locale] = document;
        }
      } catch (error) {
        if (error instanceof RangeError) report(site, 'invalid-locale', `Invalid locale "${key}".`);
        else catchData(error);
      }
    }
  } catch (error) { catchData(error); }
  if (diagnostics.length) return { story, diagnostics, files };

  const compilation = compileStory({ project, chapters, locales });
  diagnostics.push(...compilation.diagnostics.map(diagnostic => located(documents, diagnostic)));
  story = compilation.story;
  if (!story) return { story, diagnostics, files };

  for (const [assetId, asset] of Object.entries(story.definition.assets)) {
    const site = { ...projectSite, path: ['assets', assetId, 'path'] };
    try {
      if (!extensions[asset.kind].has(extname(asset.path).toLowerCase())) throw new Error(`Unexpected file extension for ${asset.kind}.`);
      const { actual, size } = await containedFile(asset.path);
      if (asset.kind === 'hya') {
        if (size > DEFAULT_HYA_COMPOSITION_LIMITS.maxInputBytes) throw new Error('HYA source exceeds the composition input limit.');
        parseHyaComposition(await readFile(actual));
      }
    } catch (error) {
      report(site, 'unreadable-asset', `Asset "${assetId}" (${asset.path}): ${error.code === 'ENOENT' ? 'file not found' : error.message}`);
    }
  }
  for (const routeId of Object.keys(story.routes)) {
    try { previewStory(story, routeId); }
    catch (error) {
      if (!(error instanceof StoryPreviewError)) throw error;
      const routePath = ['routes', routeId];
      report({ ...projectSite, path: error.step === null ? routePath : [...routePath, 'steps', error.step] }, 'invalid-preview-route', error.message);
    }
  }
  return { story: diagnostics.some(entry => entry.severity === 'error') ? null : story, diagnostics, files };
}

export async function refreshPreview(entry, routeId, lineId, previous = null) {
  const { story, diagnostics } = await loadProject(entry);
  if (!story) return { status: 'rejected', diagnostics, preview: previous };
  const stableLine = lineId ?? previous?.lineId;
  const target = stableLine ? { lineId: stableLine } : previous ? { nodeId: previous.nodeId } : {};
  try { return { status: 'ready', diagnostics, preview: previewStory(story, routeId, target) }; }
  catch (error) {
    if (!(error instanceof StoryPreviewError)) throw error;
    return { status: 'rejected', diagnostics, message: error.message, preview: previous };
  }
}
