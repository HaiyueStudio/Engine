import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { captureWithNativeBrowser } from './rive-native-browser-capture.mjs';

const common = await readFile(new URL('./rive-native-browser-capture.mjs', import.meta.url));
if (createHash('sha256').update(common).digest('hex') !== 'b1f01a3318ee6aff459a2c3ca74ff70a97a14671a100a1d6d03c9cad9039a85a') throw new Error('Official capture provider dependency identity differs from its pinned revision.');

export function capture(request) { return captureWithNativeBrowser('official', request); }
