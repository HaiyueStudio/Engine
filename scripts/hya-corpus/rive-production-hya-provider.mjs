import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { captureWithNativeBrowser } from './rive-native-browser-capture.mjs';

const common = await readFile(new URL('./rive-native-browser-capture.mjs', import.meta.url));
if (createHash('sha256').update(common).digest('hex') !== 'efbe36b441512354174170d01deb91a27967d1feb55fa15f88749cde32784ebe') throw new Error('HYA capture provider dependency identity differs from its pinned revision.');

export function capture(request) { return captureWithNativeBrowser('hya', request); }
