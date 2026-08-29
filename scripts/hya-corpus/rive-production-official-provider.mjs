import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { captureWithNativeBrowser } from './rive-native-browser-capture.mjs';

const common = await readFile(new URL('./rive-native-browser-capture.mjs', import.meta.url));
if (createHash('sha256').update(common).digest('hex') !== '304b69b847f6deb4166db64735123089ee726bc7ed689478624de36b1e349b89') throw new Error('Official capture provider dependency identity differs from its pinned revision.');

export function capture(request) { return captureWithNativeBrowser('official', request); }
