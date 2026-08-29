import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { captureWithNativeBrowser } from './rive-native-browser-capture.mjs';

const common = await readFile(new URL('./rive-native-browser-capture.mjs', import.meta.url));
if (createHash('sha256').update(common).digest('hex') !== '77abe70984fe9f4f3c3d2b8870f894b9eb1c7c12fb930140bbfa0bcfb35a6a1d') throw new Error('Official capture provider dependency identity differs from its pinned revision.');

export function capture(request) { return captureWithNativeBrowser('official', request); }
