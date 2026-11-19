import { randomUUID } from 'node:crypto';
import { realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { loadProject, refreshPreview } from './project.mjs';

const usage = [
  'node scripts/visual-novel-authoring/cli.mjs check <story.json> [--strict]',
  'node scripts/visual-novel-authoring/cli.mjs compile <story.json> --out <compiled.json> [--strict]',
  'node scripts/visual-novel-authoring/cli.mjs preview <story.json> --route <id> [--line <id>] [--reload]',
].join('\n');

async function writeCompiled(path, story, sources) {
  const requested = resolve(path);
  if (extname(requested).toLowerCase() !== '.json') throw new Error('Output must be a .json file.');
  const target = resolve(await realpath(dirname(requested)), basename(requested));
  let actual = target;
  try { actual = await realpath(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const compared = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if ([...sources].some(source => compared(source) === compared(actual))) throw new Error('Output would overwrite a source document or asset.');
  const staging = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(staging, `${JSON.stringify(story, null, 2)}\n`, { flag: 'wx' });
    await rename(staging, target);
  } finally { await rm(staging, { force: true }); }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' }, route: { type: 'string' }, line: { type: 'string' },
      reload: { type: 'boolean' }, strict: { type: 'boolean' }, help: { type: 'boolean' },
    },
  });
  if (values.help) { console.log(usage); return; }
  const [command, entry] = positionals;
  const allowed = { check: ['strict'], compile: ['strict', 'out'], preview: ['route', 'line', 'reload'] };
  if (positionals.length !== 2 || !Object.hasOwn(allowed, command) || Object.keys(values).some(key => !allowed[command].includes(key)) ||
    (command === 'compile' && !values.out) || (command === 'preview' && !values.route)) {
    throw new Error(usage);
  }
  if (command === 'preview') {
    let previous = null;
    const refresh = async () => {
      const result = await refreshPreview(entry, values.route, values.line, previous);
      previous = result.preview;
      console.log(JSON.stringify(result));
      process.exitCode = result.status === 'ready' ? 0 : 1;
    };
    await refresh();
    if (values.reload) {
      console.error('Edit and save your files, then press Enter to recompile at the current line. Enter q to quit.');
      const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      try {
        for await (const line of input) {
          if (line.trim() === 'q') break;
          if (!line.trim()) await refresh();
        }
      } finally { input.close(); }
    }
    return;
  }

  const { story, diagnostics, files } = await loadProject(entry);
  const passed = !!story && (!values.strict || !diagnostics.length);
  for (const item of diagnostics) {
    console.error(`${item.file}:${item.line}:${item.column} ${item.severity} [${item.code}] ${item.message}`);
  }
  if (passed && command === 'compile') await writeCompiled(values.out, story, files);
  console.log(JSON.stringify({ status: passed ? 'ready' : 'rejected', ...(passed && values.out ? { output: values.out } : {}), diagnostics }));
  process.exitCode = passed ? 0 : 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
