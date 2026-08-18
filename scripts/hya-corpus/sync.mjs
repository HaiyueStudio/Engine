import { readCorpusManifest, syncCorpus } from './corpus.mjs';

const manifest = readCorpusManifest();
const result = await syncCorpus(manifest, { offline: process.argv.includes('--offline') });
console.log(`[hya-corpus] ${manifest.entries.length} samples, ${result.files} pinned files: downloaded=${result.downloaded}, reused=${result.reused}.`);
