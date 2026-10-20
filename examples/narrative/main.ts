import { Entity, HaiyueEngine } from '@haiyue/engine';
import { GuiRoot, GuiButton, GuiLabel, GuiElement, type GuiRect } from '@haiyue/engine/gui';
import { I18n, bindI18nText, collectLocaleCharacters, createI18nTextureLoader, validateLocalePack } from '@haiyue/extensions/i18n';
import { NarrativeRuntime, NarrativeGui, connectNarrativeActions, validateNarrativeDefinition, type NarrativeVariables } from '@haiyue/extensions/narrative';
import { verifyNarrative } from './verification';

async function main(): Promise<void> {
  const engine = new HaiyueEngine({ canvas: '#canvas' });
  const lifetime = new AbortController();
  const i18n = new I18n({ locale: 'zh-CN', fallbackLocale: 'en' });
  let runtime: NarrativeRuntime | undefined, gui: NarrativeGui | undefined;
  const cleanup = () => { lifetime.abort(); gui?.dispose(); runtime?.dispose(); i18n.dispose(); engine.destroy(); };
  const fail = (error: unknown) => { if (!lifetime.signal.aborted) document.getElementById('error')!.textContent = String(error); };
  window.addEventListener('pagehide', cleanup, { once: true });
  try {
    await engine.init(); if (lifetime.signal.aborted) return;
    engine.run();
    const json = async (url: string) => { const response = await fetch(url, { signal: lifetime.signal }); if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`); return response.json(); };
    const [definition, ...packs] = await Promise.all([json('./story.json'), json('./locales/en.json'), json('./locales/zh-CN.json')]);
    if (lifetime.signal.aborted) return;
    const translations = packs.map(validateLocalePack); translations.forEach(pack => i18n.register(pack));
    const scene = engine.createScene({ name: 'narrative', render3D: false, render2D: false, gui: { loadOp: 'clear', font: { chars: collectLocaleCharacters(translations), atlasSize: 1024 } } });
    const root = new GuiRoot(); scene.add(new Entity('story-gui').addComponent(root)); engine.switchScene(scene);
    runtime = new NarrativeRuntime(validateNarrativeDefinition(definition));
    const story = runtime;
    const place = (element: GuiElement, y: number, height: number) => { element.layout = (r: GuiRect) => { const width = Math.min(700, r.width - 32); element.rect = { x: (r.width - width) / 2, y, width, height }; }; };
    const title = root.add(new GuiLabel({ fontSize: 28, textAlign: 'center', style: { color: '#a2e6ef' } })); place(title, 20, 42); bindI18nText(i18n, title, 'title', { signal: lifetime.signal });
    const subtitle = root.add(new GuiLabel({ fontSize: 13, textAlign: 'center', style: { color: '#9db1c9' } })); place(subtitle, 68, 28); bindI18nText(i18n, subtitle, 'subtitle', { signal: lifetime.signal });
    gui = new NarrativeGui(story, { parent: root.root, i18n, imageLoader: createI18nTextureLoader(engine.assetManager!, new URL('./', location.href).href), continueKey: 'next', waitingKey: 'wait', signal: lifetime.signal });
    const view = gui, layout = view.panel.layout.bind(view.panel);
    view.panel.layout = r => { const width = Math.min(700, r.width - 32); layout({ x: (r.width - width) / 2, y: 148, width, height: Math.max(120, r.height - 214) }); };
    const notification = root.add(new GuiLabel({ fontSize: 13, textAlign: 'center', style: { color: '#a2e6ef' } })); notification.layout = r => { notification.rect = { x: 16, y: r.height - 42, width: r.width - 32, height: 30 }; };
    const battlePanel = root.add(new GuiElement({ width: '100%', height: '100%', visible: false, style: { backgroundColor: '#17283d' } }));
    const battleTitle = battlePanel.add(new GuiLabel({ fontSize: 24, textAlign: 'center', style: { color: '#f4d299' } })); place(battleTitle, 210, 42); bindI18nText(i18n, battleTitle, 'battle.title', { signal: lifetime.signal });
    const battleHelp = battlePanel.add(new GuiLabel({ fontSize: 14, textAlign: 'center', style: { color: '#b4cce4' } })); place(battleHelp, 275, 30); bindI18nText(i18n, battleHelp, 'battle.help', { signal: lifetime.signal });
    let pendingBattle: { finish: (won: boolean) => void } | undefined;
    const setMode = (mode: 'story' | 'battle') => { view.panel.setVisible(mode === 'story'); battlePanel.setVisible(mode === 'battle'); };
    for (const [key, won, x] of [['win', true, -110], ['lose', false, 110]] as const) {
      const button = battlePanel.add(new GuiButton({ id: `battle-${key}`, onClick: () => pendingBattle?.finish(won) }));
      button.layout = r => { button.rect = { x: r.width / 2 + x - 90, y: 360, width: 180, height: 46 }; }; bindI18nText(i18n, button, key, { signal: lifetime.signal });
    }
    // This tiny host state machine stands in for an actual game's combat system.
    const actions = connectNarrativeActions(story, {
      battle: (_request, signal) => new Promise<NarrativeVariables>((resolve, reject) => {
        setMode('battle');
        const job = { finish: (won: boolean) => { signal.removeEventListener('abort', abort); if (pendingBattle === job) { pendingBattle = undefined; setMode('story'); } resolve({ won }); } };
        const abort = () => { if (pendingBattle === job) { pendingBattle = undefined; setMode('story'); } reject(new DOMException('Cancelled', 'AbortError')); };
        pendingBattle = job; signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
      'award-medal': request => {
        // The durable reward and its result are stored together. Replaying the same request is safe.
        const key = `haiyue:narrative:action:${request.token}`, saved = localStorage.getItem(key);
        if (saved) return JSON.parse(saved) as NarrativeVariables;
        const result = { medals: story.view!.variables.medals as number + 1 };
        localStorage.setItem(key, JSON.stringify(result)); return result;
      },
    }, { signal: lifetime.signal });
    const saveKey = 'haiyue:narrative:demo-save-v1';
    const operations = [
      () => { localStorage.setItem(saveKey, JSON.stringify(story.save())); notification.setText(i18n.text('saved')); },
      () => { const data = localStorage.getItem(saveKey); if (data) { story.restore(JSON.parse(data)); notification.setText(i18n.text('loaded')); } else notification.setText(i18n.text('empty')); },
      () => { story.start(crypto.randomUUID()); notification.setText(''); },
      () => { void i18n.setLocale(i18n.locale === 'en' ? 'zh-CN' : 'en', lifetime.signal).catch(fail); },
    ];
    ['save', 'load', 'restart', 'language'].forEach((key, index) => {
      const button = root.add(new GuiButton({ id: `story-${key}`, onClick: () => { try { operations[index]!(); } catch (error) { fail(error); } } }));
      button.layout = r => { const width = Math.min(160, (r.width - 56) / 4); button.rect = { x: (r.width - (width * 4 + 24)) / 2 + index * (width + 8), y: 102, width, height: 34 }; };
      bindI18nText(i18n, button, key, { signal: lifetime.signal });
    });
    story.start(crypto.randomUUID()); await view.ready;
    if (view.imageError) throw view.imageError;
    if (new URLSearchParams(location.search).has('verify')) {
      const result = await verifyNarrative(engine, root, story, view, i18n, () => pendingBattle?.finish(true), actions);
      document.getElementById('result')!.textContent = JSON.stringify(result);
    }
  } catch (error) { fail(error); cleanup(); }
}
void main();
