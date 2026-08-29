import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { captureWithNativeBrowser } from './rive-native-browser-capture.mjs';

const common = await readFile(new URL('./rive-native-browser-capture.mjs', import.meta.url));
if (createHash('sha256').update(common).digest('hex') !== '7a1556d3eee708afcb59ad2f031780c6e273c9e4e32e1ebf2788a6b5bd5665ff') throw new Error('Official capture provider dependency identity differs from its pinned revision.');

export function capture(request) { return captureWithNativeBrowser('official', request); }
