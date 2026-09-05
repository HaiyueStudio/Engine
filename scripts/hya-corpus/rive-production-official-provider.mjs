import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { captureWithNativeBrowser } from './rive-native-browser-capture.mjs';

const common = await readFile(new URL('./rive-native-browser-capture.mjs', import.meta.url));
if (createHash('sha256').update(common).digest('hex') !== '471671da035297200ad2485167f436bfbaeb6b6bb6c4e2b4d638a62fcccb71dc') throw new Error('Official capture provider dependency identity differs from its pinned revision.');

export function capture(request) { return captureWithNativeBrowser('official', request); }
