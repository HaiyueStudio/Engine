import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { captureWithNativeBrowser } from './rive-native-browser-capture.mjs';

const common = await readFile(new URL('./rive-native-browser-capture.mjs', import.meta.url));
if (createHash('sha256').update(common).digest('hex') !== '1240dac2b76df29f7f88b25d0627d3f618f5fc0992d4ae62359349fe59960836') throw new Error('HYA capture provider dependency identity differs from its pinned revision.');

export function capture(request) { return captureWithNativeBrowser('hya', request); }
