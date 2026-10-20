import assert from 'node:assert/strict';
import test from 'node:test';
import { I18n, validateLocalePack, checkLocalePacks, collectLocaleCharacters, bindI18nText, bindI18nImage, createI18nTextureLoader } from '@haiyue/extensions/i18n';
import { GuiRoot, GuiLabel, GuiImage, GuiButton } from '@haiyue/engine/gui';
import * as rootExports from '@haiyue/extensions';

const pack = (locale, messages = {}, assets = {}) => ({ schemaVersion: 1, locale, messages, assets });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const i18n = new I18n({ locale: 'en', fallbackLocale: 'en', fallbacks: { 'zh-HK': ['zh-Hant'], 'zh-Hant': ['zh-HK'] } });
  i18n.register(pack('en', { title: 'Play', score: 'Score: {score}', coins: { one: '{count} coin', other: '{count} coins' } }, { logo: 'en.png' }));
  i18n.register(pack('zh-Hant', { title: '開始', score: '得分：{score}' }, { logo: 'zh.png' }));
  return i18n;
}
test('focused public entry leaves the root unchanged', () => { assert.deepEqual(Object.keys(rootExports), ['RenderSystem2DBase']); });
test('JSON schema copies input, rejects malformed data and handles prototype-shaped keys', () => {
  const raw = JSON.parse('{"schemaVersion":1,"locale":"en-us","messages":{"__proto__":"safe","constructor":"own"},"assets":{}}');
  const checked = validateLocalePack(raw); raw.messages.constructor = 'changed';
  assert.equal(checked.locale, 'en-US'); assert.equal(checked.messages.constructor, 'own'); assert.ok(Object.isFrozen(checked.messages));
  assert.throws(() => validateLocalePack(pack('en', { count: { one: 'one' } })), /other/);
  assert.throws(() => validateLocalePack(pack('en', {}, { logo: '' })), /asset/);
  const i = new I18n({ locale: 'en-US', fallbackLocale: 'en-US' }); i.register(checked);
  assert.equal(i.text('__proto__'), 'safe'); assert.equal(i.text('toString'), 'toString'); i.dispose();
});
test('explicit script fallback is cycle safe; fallback plurals use the source language', async () => {
  const i = setup(); await i.setLocale('zh-HK');
  assert.equal(i.text('title'), '開始'); assert.equal(i.asset('logo'), 'zh.png');
  assert.equal(i.text('coins', { count: 1 }), '1 coin'); assert.equal(i.text('coins', { count: 2 }), '2 coins');
  assert.equal(i.text('score', { score: '<100>' }), '得分：<100>');
  assert.equal(i.formatNumber(1234), new Intl.NumberFormat('zh-HK').format(1234)); i.dispose();
});
test('diagnostics are opt-in and deduplicated; missing params remain visible', () => {
  const diagnostics = []; const i = new I18n({ locale: 'en', fallbackLocale: 'en', onDiagnostic: d => diagnostics.push(d) });
  i.register(pack('en', { hello: 'Hi {name}' })); assert.equal(i.text('hello'), 'Hi {name}'); i.text('hello'); i.text('missing'); i.text('missing');
  assert.equal(i.asset('missing'), undefined); assert.equal(diagnostics.length, 3); i.dispose();
});
test('completeness reports missing, extra, kind and placeholder mismatches', () => {
  const issues = checkLocalePacks(pack('en', { a: '{name}', b: 'B', c: { other: '{count}' } }, { logo: 'en.png' }), [pack('zh', { a: '{who}', c: '{count}', extra: 'x' })]);
  assert.deepEqual(issues.map(i => `${i.key}:${i.kind}`), ['a:parameters', 'b:missing-key', 'c:message-kind', 'extra:extra-key', 'logo:missing-key']);
});
test('latest locale wins even when a loader ignores cancellation; failed loads preserve locale', async () => {
  const i = setup(), slow = deferred(); let aborted;
  i.registerLoader('fr', async (_, signal) => { aborted = signal; return slow.promise; });
  const older = i.setLocale('fr'); await tick(); const newer = i.setLocale('zh-HK'); assert.equal(await newer, true);
  assert.equal(aborted.aborted, true); slow.resolve(pack('fr', { title: 'Jouer' })); assert.equal(await older, false); assert.equal(i.locale, 'zh-HK');
  i.registerLoader('de', async () => { throw new Error('offline'); }); await assert.rejects(i.setLocale('de'), /offline/); assert.equal(i.locale, 'zh-HK'); i.dispose();
});
test('preload does not switch; mismatched locale and absent packs fail', async () => {
  const i = setup(); let loads = 0; i.registerLoader('fr', async () => { loads++; return pack('fr', { title: 'Jouer' }); });
  await i.preload('fr'); assert.equal(i.locale, 'en'); await i.setLocale('fr'); assert.equal(loads, 1);
  i.registerLoader('de', async () => pack('es')); await assert.rejects(i.setLocale('de'), /expected de/); i.dispose();
  const empty = new I18n({ locale: 'en', fallbackLocale: 'en' }); await assert.rejects(empty.setLocale('en'), /No language pack/); empty.dispose();
});
test('aborted and disposed requests do not commit; registering while loading wins', async () => {
  const i = setup(), slow = deferred(); i.registerLoader('fr', () => slow.promise);
  const pending = i.setLocale('fr'); await tick(); i.register(pack('fr', { title: 'Registered' })); slow.resolve(pack('fr', { title: 'Stale' }));
  await pending; assert.equal(i.text('title'), 'Registered');
  const controller = new AbortController(); controller.abort(); assert.equal(await i.setLocale('en', controller.signal), false);
  const d = deferred(); i.registerLoader('de', () => d.promise); const p = i.setLocale('de'); await tick(); i.dispose(); d.resolve(pack('de')); assert.equal(await p, false);
});
test('text bindings update only changed nodes, refresh parameters and release on abort', async () => {
  const i = setup(), root = new GuiRoot(), label = root.add(new GuiLabel()), untouched = root.add(new GuiLabel({ text: 'static' }));
  const controller = new AbortController(); const binding = bindI18nText(i, label, 'score', { params: { score: 1 }, signal: controller.signal });
  const button = new GuiButton(); bindI18nText(i, button, 'title'); root.clearDirty(); binding.setParams({ score: 1 }); assert.equal(root.dirty, false);
  binding.setParams({ score: 2 }); assert.equal(label.text, 'Score: 2'); assert.equal(root.root.getDirtyFlags(), 0); assert.equal(untouched.dirty, false);
  await i.setLocale('zh-HK'); assert.equal(label.text, '得分：2'); assert.equal(button.text, '開始');
  controller.abort(); await i.setLocale('en'); assert.equal(label.text, '得分：2'); binding.dispose(); i.dispose();
});
test('image replacement preserves dimensions, releases stale loads and retains image on failure', async () => {
  const i = setup(), target = new GuiImage({ width: 240, height: 80 }), fallback = new GuiLabel(); const requests = [], releases = [];
  const binding = bindI18nImage(i, target, 'logo', { textKey: 'title', fallbackLabel: fallback, load: (path, signal) => { const d = deferred(); requests.push({ path, signal, ...d }); return d.promise; } });
  assert.equal(fallback.text, 'Play'); assert.equal(fallback.visible, true);
  await i.setLocale('zh-HK'); assert.equal(requests[0].signal.aborted, true);
  const texture = {}; requests[1].resolve({ texture, release: () => releases.push('zh') }); await binding.ready;
  const source = target.source; assert.equal(source.texture, texture); assert.equal(fallback.visible, false); assert.equal(binding.description, '開始');
  requests[0].resolve({ texture: {}, release: () => releases.push('stale') }); await tick(); assert.deepEqual(releases, ['stale']);
  await i.setLocale('en'); requests[2].reject(new Error('offline')); await binding.ready; assert.match(binding.error.message, /offline/); assert.equal(target.source, source); assert.equal(binding.description, '開始');
  const retry = binding.refresh(); requests[3].resolve({ texture: {}, release: () => releases.push('en') }); await retry;
  assert.equal(target.source, source); assert.equal(source.version, 1); assert.equal(binding.description, 'Play'); assert.deepEqual(releases, ['stale', 'zh']);
  assert.deepEqual(target.getLayoutOptions(), { x: 0, y: 0, width: 240, height: 80 });
  i.dispose(); assert.equal(target.source, null); assert.deepEqual(releases, ['stale', 'zh', 'en']); binding.dispose();
});
test('image disposal cancels pending work and late handles release exactly once', async () => {
  const i = setup(), d = deferred(), target = new GuiImage(), controller = new AbortController(); let releases = 0;
  const binding = bindI18nImage(i, target, 'logo', { textKey: 'title', signal: controller.signal, load: () => d.promise });
  controller.abort(); d.resolve({ texture: {}, release: () => releases++ }); await binding.ready;
  assert.equal(target.source, null); assert.equal(releases, 1); i.dispose();
});
test('missing image uses fallback; already-aborted bindings neither load nor subscribe', async () => {
  const i = setup(), label = new GuiLabel(), target = new GuiImage(); let loads = 0;
  const image = bindI18nImage(i, target, 'missing', { textKey: 'title', fallbackLabel: label, load: async () => { loads++; throw new Error(); } });
  await image.ready; assert.match(image.error.message, /Missing localized/); assert.equal(label.text, 'Play'); assert.equal(loads, 0);
  const c = new AbortController(); c.abort(); bindI18nText(i, label, 'score', { signal: c.signal });
  bindI18nImage(i, target, 'logo', { textKey: 'title', signal: c.signal, load: async () => { loads++; throw new Error(); } });
  assert.equal(loads, 0); i.dispose();
});
test('texture adapter resolves game-relative URLs and forwards abort/refcounts', async () => {
  let release = 0; const texture = {}, c = new AbortController();
  const load = createI18nTextureLoader({ loadTexture: async (path, options) => { assert.equal(path, 'https://game.test/assets/title.png'); assert.equal(options.signal, c.signal); return { value: texture, release: () => release++ }; } }, 'https://game.test/');
  const handle = await load('assets/title.png', c.signal); assert.equal(handle.texture, texture); handle.release(); assert.equal(release, 1);
});

test('font repertoire contains every plural form, Unicode code point and extra glyph without duplicates', () => {
  const chars = collectLocaleCharacters([pack('zh', { title: '开始', coins: { one: '甲', other: '乙' } })], '😀开始');
  for (const glyph of ['开', '始', '甲', '乙', '😀', '0', '?']) assert.ok(chars.includes(glyph));
  assert.equal([...chars].length, new Set([...chars]).size);
});
