import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { configureFrameGraphDownloads } from './framegraph-example-download-policy.mjs';

const directory = resolve('owned-framegraph-downloads');
test('configures downloads for the current isolated page rather than the default context', async () => {
  const calls = [];
  const cdp = { async call(method, params) {
    calls.push({ method, params });
    return { result: method === 'Target.getTargetInfo' ? { targetInfo: { type: 'page', targetId: 'fixture-page', browserContextId: 'fixture-context' } } : {} };
  } };
  assert.deepEqual(await configureFrameGraphDownloads(cdp, directory), { targetId: 'fixture-page', browserContextId: 'fixture-context' });
  assert.deepEqual(calls, [
    { method: 'Target.getTargetInfo', params: undefined },
    { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', downloadPath: directory, browserContextId: 'fixture-context' } },
  ]);
});

test('missing or invalid page/context identity never falls back to the default context', async () => {
  for (const targetInfo of [undefined, {}, { type:'browser',targetId:'page',browserContextId:'context' },
    { type:'page',targetId:'',browserContextId:'context' },
    ...[undefined,'',42].map(browserContextId => ({ type:'page',targetId:'page',browserContextId }))]) {
    const calls=[];
    const cdp={ async call(method) { calls.push(method); return { result:{targetInfo} }; } };
    await assert.rejects(configureFrameGraphDownloads(cdp,directory), /isolated browser context/);
    assert.deepEqual(calls,['Target.getTargetInfo']);
  }
});

test('rejects relative output paths and propagates protocol failures without retry or fallback', async () => {
  for (const path of [undefined,'','relative-downloads',42]) {
    let called=false;
    await assert.rejects(configureFrameGraphDownloads({ async call() { called=true; } },path),/absolute output/);
    assert.equal(called,false);
  }
  for (const failedMethod of ['Target.getTargetInfo','Browser.setDownloadBehavior']) {
    const calls=[], failure=new Error('protocol rejected '+failedMethod);
    const cdp={ async call(method) {
      calls.push(method); if(method===failedMethod)throw failure;
      return {result:{targetInfo:{type:'page',targetId:'page',browserContextId:'context'}}};
    } };
    await assert.rejects(configureFrameGraphDownloads(cdp,directory),error=>error===failure);
    assert.deepEqual(calls,failedMethod==='Target.getTargetInfo'?['Target.getTargetInfo']:['Target.getTargetInfo','Browser.setDownloadBehavior']);
  }
});
