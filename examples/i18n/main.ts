import { Entity, HaiyueEngine } from '@haiyue/engine';
import { GuiRoot, GuiLabel, GuiButton, GuiImage, type GuiElement, type GuiRect } from '@haiyue/engine/gui';
import { I18n, bindI18nText, bindI18nImage, createI18nTextureLoader, checkLocalePacks, validateLocalePack, collectLocaleCharacters } from '@haiyue/extensions/i18n';

async function main(): Promise<void> {
  const engine = new HaiyueEngine({ canvas: '#canvas', clearColor: { r: 0.028, g: 0.05, b: 0.085, a: 1 } });
  const lifetime = new AbortController();
  const i18n = new I18n({ locale: 'zh-CN', fallbackLocale: 'en', fallbacks: { 'zh-HK': ['zh-Hant'] }, onDiagnostic: d => console.warn('i18n', d) });
  const fail = (cause: unknown) => { if (!lifetime.signal.aborted) document.getElementById('error')!.textContent = String(cause); };
  const cleanup = () => { lifetime.abort(); i18n.dispose(); engine.destroy(); };
  window.addEventListener('pagehide', cleanup, { once: true });
  try {
    await engine.init();
    if (lifetime.signal.aborted) return;
    engine.device.pushErrorScope('validation');
    engine.run();
    const locales = ['en', 'zh-CN', 'zh-Hant'];
    const packs = new Map<string, ReturnType<typeof validateLocalePack>>();
    for (const locale of locales) i18n.registerLoader(locale, async (_, signal) => {
      const response = await fetch(`./locales/${locale}.json`, { signal });
      if (!response.ok) throw new Error(`Language pack HTTP ${response.status}`);
      const pack = validateLocalePack(await response.json()); packs.set(locale, pack); return pack;
    });
    await Promise.all(locales.map(locale => i18n.preload(locale, lifetime.signal)));
    await i18n.setLocale('zh-CN', lifetime.signal);
    if (lifetime.signal.aborted) return;
    const chars = collectLocaleCharacters([...packs.values()], 'English简体中文繁體中文');
    const scene = engine.createScene({ name: 'i18n', render3D: false, render2D: false, gui: { loadOp: 'clear', font: { chars, fontFamily: 'sans-serif', atlasSize: 1024 } } });
    const root = new GuiRoot(); scene.add(new Entity('localized-menu').addComponent(root));
    engine.switchScene(scene);
    const place = (element: GuiElement, y: number, width: number, height: number) => {
      element.layout = (r: GuiRect) => { element.rect = { x: Math.max(20, (r.width - width) / 2), y, width: Math.min(width, r.width - 40), height }; };
    };
    const eyebrow = root.add(new GuiLabel({ text: 'HAIYUE / INTERNATIONALIZATION', fontSize: 12, textAlign: 'center', style: { color: '#7dd3fc' } })); place(eyebrow, 32, 500, 24);
    const heading = root.add(new GuiLabel({ fontSize: 27, textAlign: 'center', style: { color: '#eef6ff' } })); place(heading, 78, 600, 44);
    bindI18nText(i18n, heading, 'heading', { signal: lifetime.signal });
    const artwork = root.add(new GuiImage()); place(artwork, 150, 360, 120);
    const fallback = root.add(new GuiLabel({ textAlign: 'center', fontSize: 36 })); place(fallback, 185, 360, 60);
    const image = bindI18nImage(i18n, artwork, 'title.logo', { textKey: 'title', fallbackLabel: fallback, signal: lifetime.signal, load: createI18nTextureLoader(engine.assetManager!, new URL('./', location.href).href) });
    const score = root.add(new GuiLabel({ textAlign: 'center', fontSize: 21, style: { color: '#c9d9ed' } })); place(score, 302, 380, 32);
    bindI18nText(i18n, score, 'score', { params: { score: 1200 }, signal: lifetime.signal });
    const coins = root.add(new GuiLabel({ textAlign: 'center', fontSize: 18, style: { color: '#fcd68d' } })); place(coins, 346, 380, 28);
    let count = 1;
    const counter = bindI18nText(i18n, coins, 'coins', { params: { count }, signal: lifetime.signal });
    const add = root.add(new GuiButton({ variant: 'primary', onClick: () => counter.setParams({ count: ++count }) })); place(add, 395, 180, 40);
    bindI18nText(i18n, add, 'add', { signal: lifetime.signal });
    const tip = root.add(new GuiLabel({ textAlign: 'center', fontSize: 14, style: { color: '#91a8c1' } })); place(tip, 468, 600, 26);
    bindI18nText(i18n, tip, 'tip', { signal: lifetime.signal });
    const switchLanguage = async (locale: string) => {
      if (!await i18n.setLocale(locale, lifetime.signal)) return;
      await image.ready;
      if (lifetime.signal.aborted) return;
      if (image.error) throw image.error;
      document.documentElement.lang = locale;
      engine.canvas!.setAttribute('aria-label', image.description);
    };
    const buttons = locales.map((locale, index) => {
      const button = root.add(new GuiButton({ text: ['English', '简体中文', '繁體中文'][index]!, onClick: () => { void switchLanguage(locale).catch(fail); } }));
      button.layout = r => { const width = Math.min(130, (r.width - 56) / 3); button.rect = { x: (r.width - width * 3 - 16) / 2 + index * (width + 8), y: 526, width, height: 40 }; };
      return button;
    });
    await image.ready;
    if (image.error) throw image.error;
    if (new URLSearchParams(location.search).has('verify')) {
      const frame = () => new Promise<void>(resolve => engine.once('after-update', () => resolve()));
      const observed: string[] = [];
      for (const [index, locale] of locales.entries()) {
        await frame();
        const button = buttons[index]!;
        const canvas = engine.canvas!;
        const rect = canvas.getBoundingClientRect();
        const capture = canvas.setPointerCapture.bind(canvas), release = canvas.releasePointerCapture.bind(canvas);
        // Fixture pointers have no OS capture; real input keeps its normal behavior.
        canvas.setPointerCapture = id => { if (id !== 8156) capture(id); };
        canvas.releasePointerCapture = id => { if (id !== 8156) release(id); };
        try {
          for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new PointerEvent(type, {
            pointerId: 8156, pointerType: 'touch', isPrimary: true, button: 0, bubbles: true,
            clientX: rect.left + button.rect.x + button.rect.width / 2,
            clientY: rect.top + button.rect.y + button.rect.height / 2,
          }));
          for (let tries = 0; tries < 120; tries++) {
            await frame();
            if (i18n.locale === locale) break;
          }
          if (i18n.locale !== locale) throw new Error(`Language button failed: ${locale}`);
          await image.ready;
        } finally { canvas.setPointerCapture = capture; canvas.releasePointerCapture = release; }
        await frame(); await frame();
        if (heading.text !== i18n.text('heading') || !artwork.source || fallback.visible) throw new Error(`GUI binding failed: ${locale}`);
        observed.push(artwork.sourceKey!);
      }
      if (new Set(observed).size !== 3) throw new Error('Artwork did not change.');
      const issues = checkLocalePacks(packs.get('en')!, [...packs.values()]);
      if (issues.length) throw new Error(JSON.stringify(issues));
      await Promise.all([switchLanguage('en'), switchLanguage('zh-CN'), switchLanguage('zh-Hant')]);
      if (i18n.locale !== 'zh-Hant') throw new Error('Latest language did not win.');
      await switchLanguage('en'); counter.setParams({ count: count = 2 });
      if (coins.text !== '2 coins') throw new Error('Plural binding failed.');
      await frame(); await frame();
      const error = await engine.device.popErrorScope(); if (error) throw new Error(error.message);
      document.getElementById('result')!.textContent = JSON.stringify({ passed: true, locales, observed, heading: heading.text, coins: coins.text, buttons: buttons.length, issues, checks: ['GPU GUI', 'GUI pointer buttons', 'localized textures', 'parameters', 'plurals', 'latest-wins', 'pack completeness'] });
    } else { const error = await engine.device.popErrorScope(); if (error) throw new Error(error.message); }
  } catch (error) { fail(error); cleanup(); }
}
void main();
