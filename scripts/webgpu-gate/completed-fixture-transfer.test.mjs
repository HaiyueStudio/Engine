import test from 'node:test';
import assert from 'node:assert/strict';
import { readCompletedFixtureText } from './completed-fixture-transfer.mjs';
function fake(text, mutate = x => x) { const calls = []; let cleaned = false; return { calls, get cleaned() { return cleaned; }, async call(method, { expression }) { calls.push(expression); if (expression.startsWith('delete')) {
        cleaned = true;
        return {};
    } if (expression.startsWith('(()'))
        return { result: { result: { value: { status: 'passed', length: text.length } } } }; const [, s, e] = expression.match(/slice\((\d+),(\d+)\)/); return { result: { result: { value: mutate(text.slice(+s, +e)) } } }; } }; }
test('chunk transport retains exact JSON and Unicode across boundaries after completion', async () => { const text = JSON.stringify({ frames: Array.from({ length: 30 }, (_, i) => ({ i, label: '中文😀' })) }), cdp = fake(text); const r = await readCompletedFixtureText(cdp, { chunkChars: 7 }); assert.equal(r.text, text); assert.deepEqual(JSON.parse(r.text), JSON.parse(text)); assert.equal(r.characters, text.length); assert.ok(r.chunks > 1); assert.ok(cdp.cleaned); });
test('truncated result chunks fail and release transport reference', async () => { const cdp = fake('abcdef', x => x.slice(1)); await assert.rejects(() => readCompletedFixtureText(cdp, { chunkChars: 2 }), /Incomplete/); assert.ok(cdp.cleaned); });
test('empty and excessive transfers fail with cleanup', async () => { for (const [text, maxChars] of [['', 5], ['abcdef', 5]]) {
    const cdp = fake(text);
    await assert.rejects(() => readCompletedFixtureText(cdp, { maxChars }), /Invalid/);
    assert.ok(cdp.cleaned);
} });
