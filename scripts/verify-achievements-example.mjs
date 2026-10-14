import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await runChromeWebGpuFixture({ root, fixture: 'examples/achievements/index.html', query: { verify: 1 }, timeoutMs: 90000,
  visualCapture: { viewportWidth: 960, viewportHeight: 700, sampleWidth: 48, sampleHeight: 35 }, navigateAwayAfterResult: true });
if (result.status !== 'passed' || result.records?.[1]?.value !== 1 || result.guiRows !== 4 || result.visualCapture.darkRatio > .98) throw Error(`Achievement browser validation failed: ${JSON.stringify(result)}`);
mkdirSync(resolve(root, 'artifacts/achievements'), { recursive: true });
if (result.visualCapture.pngBase64) {
  writeFileSync(resolve(root, 'artifacts/achievements/browser.png'), Buffer.from(result.visualCapture.pngBase64, 'base64'));
  delete result.visualCapture.pngBase64;
}
writeFileSync(resolve(root, 'artifacts/achievements/browser.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, locale: result.locale, guiRows: result.guiRows, darkRatio: result.visualCapture.darkRatio }));
