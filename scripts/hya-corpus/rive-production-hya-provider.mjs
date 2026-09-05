import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { captureWithNativeBrowser } from './rive-native-browser-capture.mjs';

const common = await readFile(new URL('./rive-native-browser-capture.mjs', import.meta.url));
if (createHash('sha256').update(common).digest('hex') !== 'ad9372f67f0465b5e2754f434b2064158485b4f4f01838f037e3ed460214166f') throw new Error('HYA capture provider dependency identity differs from its pinned revision.');

export function capture(request) { return captureWithNativeBrowser('hya', request); }
