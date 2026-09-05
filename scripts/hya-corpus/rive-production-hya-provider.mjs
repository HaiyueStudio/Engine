import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { captureWithNativeBrowser } from './rive-native-browser-capture.mjs';

const common = await readFile(new URL('./rive-native-browser-capture.mjs', import.meta.url));
if (createHash('sha256').update(common).digest('hex') !== '68bb5388f98c4889952fe072e4bdec90c34bdcee598cd5035dd51ef88b82c614') throw new Error('HYA capture provider dependency identity differs from its pinned revision.');

export function capture(request) { return captureWithNativeBrowser('hya', request); }
