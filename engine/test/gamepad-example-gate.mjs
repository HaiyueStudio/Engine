import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {decodePng} from '../../scripts/visual-regression/png.mjs';
import {runChromeWebGpuFixture} from '../../scripts/webgpu-gate/chrome-runner.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dir = resolve(root, 'artifacts/engine-0.2.2/gamepad-input-' + Date.now());
mkdirSync(dir, {recursive: true});
const cases = [];
let report;
try {
  report = await runChromeWebGpuFixture({root, fixture: 'examples/gamepad-input/index.html', timeoutMs: 90000, acceptedStatuses: ['passed', 'failed'], interact: async cdp => {
    const evaluate = async expression => {
      const response = await cdp.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
      if (response.result?.exceptionDetails) throw Error(JSON.stringify(response.result.exceptionDetails));
      return response.result?.result?.value;
    };
    const state = () => evaluate('JSON.parse(document.body.dataset.gamepad || "null")');
    const wait = async predicate => {
      for (let i = 0; i < 200; i++) {const s = await state(); if (s && await predicate(s)) return s; await new Promise(r => setTimeout(r, 25));}
      throw Error('Gamepad state timeout: ' + JSON.stringify(await state()));
    };
    const snapshot = async name => {
      const response = await cdp.call('Page.captureScreenshot', {format: 'png'});
      const bytes = Buffer.from(response.result.data, 'base64'); writeFileSync(resolve(dir, name + '.png'), bytes); return decodePng(bytes);
    };
    const publish = data => evaluate(`(()=>{const el=document.createElement('pre');el.id='result';el.dataset.status=${JSON.stringify(data.status)};el.textContent=${JSON.stringify(JSON.stringify(data))};document.body.append(el);})()`);
    try {
      await cdp.call('Emulation.setDeviceMetricsOverride', {width: 1360, height: 900, deviceScaleFactor: 1, mobile: false});
      await wait(s => s.ready);
      // Synthetic Gamepad API packets exercise the actual Engine sampler and page.
      // This is repeatable browser coverage, not evidence of physical hardware acceptance.
      await evaluate(`window.testPads=[]; window.makePad=(index,id='Test controller',mapping='standard')=>({index,id,mapping,connected:true,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))}); Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>window.testPads}); window.dispatchEvent(new Event('focus'));`);
      await wait(s => s.selected === -1); await snapshot('disconnected');
      await evaluate('testPads=[makePad(0)]'); await wait(s => s.selected === 0);
      const before = await snapshot('neutral');
      await evaluate('testPads[0].buttons[0]={pressed:true,value:1};testPads[0].buttons[6]={pressed:false,value:.35};testPads[0].buttons[7]={pressed:true,value:.85};testPads[0].axes=[-.75,.5,.6,-.8]');
      const held = await wait(s => s.values.A === 1 && s.values.RT === .85);
      assert.equal(held.values.LT, .35); assert.equal(held.values.LeftX, -.75);
      await new Promise(r => setTimeout(r, 180));
      const after = await snapshot('active');
      const rect = await evaluate("(()=>{const r=document.getElementById('key-A').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()");
      let changed = 0;
      for (let y = Math.ceil(rect.y); y < Math.floor(rect.y + rect.height); y++) for (let x = Math.ceil(rect.x); x < Math.floor(rect.x + rect.width); x++) {
        const i = (y * after.width + x) * 4;
        if (after.data.slice(i, i + 3).some((v, k) => Math.abs(v - before.data[i + k]) > 20)) changed++;
      }
      assert.ok(changed > 100, 'pressed button must visibly change pixels');
      assert.equal(await evaluate("document.getElementById('stick-left').getAttribute('transform')"), 'translate(-17.25 11.5)');
      assert.equal(await evaluate("document.getElementById('rt-value').textContent"), '85%');
      cases.push({id: 'live-sticks-pressure-and-pressed-pixels', changed});
      const logCount = held.logCount; await new Promise(r => setTimeout(r, 350)); assert.equal((await state()).logCount, logCount);
      cases.push({id: 'held-controls-do-not-flood-log'});
      await evaluate('testPads=[]'); await wait(s => s.selected === -1 && !s.values.A);
      assert.equal(await evaluate("document.querySelectorAll('.button.active').length"), 0);
      assert.equal(await evaluate("document.getElementById('stick-left').getAttribute('transform')"), 'translate(0 0)');
      assert.match(await evaluate("document.getElementById('log').textContent"), /回中/);
      cases.push({id: 'disconnect-releases-and-recenters'});
      await evaluate('testPads=[makePad(0)]'); await wait(s => s.selected === 0);
      for (let i = 0; i < 17; i++) {
        await evaluate(`testPads[0].buttons[${i}]={pressed:true,value:1}`);
      }
      await wait(s => s.values.Home === 1);
      assert.equal(await evaluate("document.querySelectorAll('.button.active').length"), 17);
      cases.push({id: 'all-17-standard-buttons-including-dpad-shoulders-back-menu'});
      await evaluate('testPads[2]=makePad(2,"Second controller");testPads[2].buttons[2]={pressed:true,value:1}');
      await wait(async () => evaluate("!!document.querySelector('#device option[value=\"2\"]')"));
      await evaluate("document.getElementById('device').value='2';document.getElementById('device').dispatchEvent(new Event('change'))");
      await wait(s => s.selected === 2 && s.values.X === 1 && s.values.A === 0);
      cases.push({id: 'sparse-index-device-switch'});
      await evaluate("window.dispatchEvent(new Event('blur'))"); await wait(s => s.paused && !s.values.X);
      await evaluate("window.dispatchEvent(new Event('focus'))"); await wait(s => !s.paused && s.values.X === 1);
      cases.push({id: 'blur-clears-focus-resumes'});
      await evaluate('testPads=[makePad(0,"Unknown mapping","")]'); await wait(s => s.selected === 0 && s.mapping === '');
      assert.equal(await evaluate("document.querySelectorAll('.button.active').length"), 0);
      assert.match(await evaluate("document.getElementById('hint').textContent"), /未提供 standard/);
      cases.push({id: 'nonstandard-device-not-mislabeled'});
      await evaluate("document.getElementById('clear').click()"); await wait(s => s.logCount === 0);
      assert.equal(await evaluate("document.getElementById('empty').hidden"), false);
      await cdp.call('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: false});
      await snapshot('mobile');
      assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile must not overflow horizontally');
      cases.push({id: 'clear-and-narrow-layout'});
      await evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))"); await wait(s => s.disposed);
      await evaluate('testPads=[makePad(0)];testPads[0].buttons[0]={pressed:true,value:1}');
      await new Promise(r => setTimeout(r, 100)); assert.equal((await state()).disposed, true); assert.equal((await state()).values.A, undefined);
      await evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))"); await wait(s => !s.disposed && s.values.A === 1);
      cases.push({id: 'pagehide-disposes-bfcache-restores'});
      await publish({status: 'passed', schemaVersion: 1, inputSource: 'synthetic Gamepad API through real Engine sampler', physicalHardwareVerified: false, caseCount: cases.length, cases});
    } catch (error) {await publish({status: 'failed', error: String(error.stack ?? error), cases});}
  }});
} catch (error) {report = {status: 'failed', error: String(error.stack ?? error), browserFailure: error.browserFailure};}
const served = report.httpProvenance?.files ?? [];
const bad = served.filter(f => createHash('sha256').update(readFileSync(resolve(root, f.sourcePath))).digest('hex') !== f.sha256);
if (!served.length || bad.length) report = {...report, status: 'failed', servedByteMismatch: bad};
writeFileSync(resolve(dir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({dir, status: report.status, cases: report.caseCount, error: report.error}));
if (report.status !== 'passed' || report.caseCount !== 9) process.exitCode = 1;
