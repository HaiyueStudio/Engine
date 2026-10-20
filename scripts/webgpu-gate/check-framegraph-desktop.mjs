import fs from 'node:fs';
import { desktopPreflightReasons } from './framegraph-desktop-policy.mjs';
const snapshot = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
const reasons = desktopPreflightReasons(snapshot);
console.log(JSON.stringify({ status: reasons.length ? 'blocked-desktop-condition' : 'desktop-preflight-passed', settingsChanged: false, reasons, snapshot }));
if (reasons.length)
    process.exitCode = 1;
