import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { captureWithNativeBrowser } from './rive-native-browser-capture.mjs';

const common = await readFile(new URL('./rive-native-browser-capture.mjs', import.meta.url));
if (createHash('sha256').update(common).digest('hex') !== '14bb28f4a55ee0c4e1c64d61da4c7bc0b664fbf1d742a4c78a617430f935cecb') throw new Error('HYA capture provider dependency identity differs from its pinned revision.');

export function capture(request) { return captureWithNativeBrowser('hya', request); }
