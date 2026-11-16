import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const tool = process.argv[2];
if (!tool) throw new Error('Pass the directory of the isolated Spellophone 0.2.1 extraction.');
const { createEspeak, encodeWav } = await import(pathToFileURL(resolve(tool, 'dist/node.js')));
const synth = await createEspeak({ languages: ['en', 'cmn'] });
const project = fileURLToPath(new URL('../project/', import.meta.url));
const out = join(project, 'assets');
await mkdir(out, { recursive: true });
const mapping = {
  arrival:'arrival.watch', pier:'pier.story', lantern:'ending.lanternLine', tide:'ending.tideLine',
};
for (const [language, voice, suffix] of [['zh-Hans','cmn','zh'], ['en','en-gb','en']]) {
  const locale = JSON.parse(await readFile(join(project, language + '.json'), 'utf8'));
  for (const [id,key] of Object.entries(mapping)) {
    const { samples, sampleRate } = synth.synthesize(locale.messages[key], { voice });
    if (samples.length < sampleRate / 3 || !samples.some(value => Math.abs(value) > 100)) throw new Error('Silent voice: ' + id + suffix);
    await writeFile(join(out, id + '-' + suffix + '.wav'), encodeWav(samples, sampleRate));
  }
}

const rate = 22050, seconds = 8;
const pcm = Int16Array.from({ length:rate * seconds }, (_, index) => {
  const time = index/rate;
  const frequencies = [55,82.5,110,138.625,165,220];
  const chords = frequencies.reduce((sum, hz, i) => {
    const rise = .38 + .26 * Math.cos((time/seconds + i*.13) * Math.PI * 2);
    return sum + Math.sin(time * Math.PI * 2 * hz) * rise / (1+i*.55);
  }, 0);
  return Math.round(chords * 2850);
});
await writeFile(join(out, 'harbor-loop.wav'), encodeWav(pcm, rate));
