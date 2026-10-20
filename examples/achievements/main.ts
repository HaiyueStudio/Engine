import { Entity, HaiyueEngine } from '@haiyue/engine';
import { GuiRoot, GuiButton, GuiLabel } from '@haiyue/engine/gui';
import { AchievementRuntime, AchievementGui } from '@haiyue/extensions/achievements';
import { I18n, collectLocaleCharacters, type LocalePack } from '@haiyue/extensions/i18n';

const packs: LocalePack[] = [
  { schemaVersion: 1, locale: 'zh-CN', messages: { title: '成就实验室', subtitle: '事件驱动 · 持久进度 · GPU 界面', first: '初露锋芒', ten: '十次挑战', best: '超越自己', secret: '隐藏航线', desc: '点击上方按钮模拟游戏事实', hidden: '隐藏成就', locked: '未解锁', unlocked: '成就解锁', win: '完成一局', score: '得分 +25', mystery: '探索', local: '本地记录' } },
  { schemaVersion: 1, locale: 'en', messages: { title: 'Achievement lab', subtitle: 'Event driven · Durable progress · GPU GUI', first: 'First victory', ten: 'Ten challenges', best: 'Personal best', secret: 'Hidden route', desc: 'Use the buttons to simulate game facts', hidden: 'Hidden achievement', locked: 'Locked', unlocked: 'Achievement unlocked', win: 'Win a round', score: 'Score +25', mystery: 'Explore', local: 'Local record' } },
];
async function main() {
  const engine = new HaiyueEngine({ canvas: '#canvas', clearColor: { r: .025, g: .05, b: .09, a: 1 } });
  const i18n = new I18n({ locale: 'zh-CN', fallbackLocale: 'en' }); packs.forEach(p => i18n.register(p));
  const lifetime = new AbortController(), verify = new URLSearchParams(location.search).has('verify');
  const memory = new Map<string, string>();
  const store = verify ? { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); } } : localStorage;
  const runtime = new AchievementRuntime({ profile: 'example/achievements/local/guest', definitionVersion: '1', definitions: [
    { id: 'first', target: 1, titleKey: 'first', descriptionKey: 'desc', rule: { kind: 'fact', event: 'win' } },
    { id: 'ten', target: 10, titleKey: 'ten', descriptionKey: 'desc', rule: { kind: 'counter', event: 'win', field: 'count' } },
    { id: 'best', target: 100, titleKey: 'best', descriptionKey: 'desc', rule: { kind: 'best', event: 'score', field: 'score' } },
    { id: 'secret', target: 1, titleKey: 'secret', descriptionKey: 'desc', hidden: true, rule: { kind: 'fact', event: 'secret' } },
  ], storage: { async read(k) { const s = store.getItem(k); return s ? JSON.parse(s) : null; }, async write(k, v) { store.setItem(k, JSON.stringify(v)); } },
  // This demo has no SDK. Rule storage is the durable local record; Native is injected by games.
  port: { contractVersion: 1, async reportProgress(id) { return { id, state: 'local-only', sessionGeneration: 1 }; }, async unlock(id) { return { id, state: 'local-only', sessionGeneration: 1 }; } } });
  let gui: AchievementGui | undefined, score = 0;
  const cleanup = () => { lifetime.abort(); gui?.dispose(); runtime.dispose(); i18n.dispose(); engine.destroy(); };
  window.addEventListener('pagehide', cleanup, { once: true });
  const fail = (e: unknown) => { document.getElementById('error')!.textContent = String(e); const result = document.getElementById('result')!; result.dataset.status = 'failed'; result.textContent = JSON.stringify({ status: 'failed', error: String(e) }); };
  try {
    await engine.init(); await runtime.initialize(); if (lifetime.signal.aborted) return;
    const scene = engine.createScene({ name: 'achievements', render3D: false, render2D: false, gui: { loadOp: 'clear', font: { chars: collectLocaleCharacters(packs) + '中文', atlasSize: 1024 } } });
    const root = new GuiRoot(); scene.add(new Entity('achievement-gui').addComponent(root)); engine.switchScene(scene); engine.run();
    const title = root.add(new GuiLabel({ y: 20, width: '100%', height: 42, textAlign: 'center', fontSize: 30, style: { color: '#a3edd8' } }));
    const subtitle = root.add(new GuiLabel({ y: 68, width: '100%', height: 25, textAlign: 'center', fontSize: 14, style: { color: '#9bb1cb' } }));
    gui = new AchievementGui(runtime, { parent: root.root, i18n, hiddenKey: 'hidden', lockedKey: 'locked', unlockedKey: 'unlocked', syncKeys: { 'local-only': 'local' }, signal: lifetime.signal });
    const panel = gui.panel, layout = panel.layout.bind(panel);
    panel.layout = r => { const width = Math.min(720, r.width - 24); layout({ x: (r.width - width) / 2, y: 158, width, height: Math.max(100, r.height - 180) }); };
    gui.toast.layout = r => { gui!.toast.rect = { x: 16, y: r.height - 58, width: r.width - 32, height: 42 }; };
    const emit = async (type: string, values?: Record<string, number>, id: string = crypto.randomUUID()) => { await runtime.record({ id, type, ...(values ? { values } : {}) }); await runtime.sync(); };
    const actions = [() => emit('win', { count: 1 }), () => emit('score', { score: score += 25 }), () => emit('secret'), () => i18n.setLocale(i18n.locale === 'en' ? 'zh-CN' : 'en')];
    const buttons = ['win', 'score', 'mystery', 'language'].map((key, index) => {
      const b = root.add(new GuiButton({ id: `achievement-${key}`, onClick: () => { void actions[index]!().catch(fail); } }));
      b.layout = r => { const width = Math.min(166, (r.width - 40) / 4); b.rect = { x: (r.width - width * 4 - 18) / 2 + index * (width + 6), y: 108, width, height: 34 }; }; return b;
    });
    const translate = () => { title.setText(i18n.text('title')); subtitle.setText(i18n.text('subtitle')); ['win', 'score', 'mystery'].forEach((k, i) => buttons[i]!.setText(i18n.text(k))); buttons[3]!.setText('EN / 中文'); };
    i18n.subscribe(translate); translate();
    if (verify) {
      await emit('win', { count: 1 }, 'verification-1'); await emit('win', { count: 1 }, 'verification-1'); await emit('score', { score: 100 }); await i18n.setLocale('en');
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await engine.device.queue.onSubmittedWorkDone();
      const records = runtime.snapshot().records;
      if (records[1]?.value !== 1 || records[2]?.value !== 100 || !panel.children.length) throw new Error('Achievement verification failed');
      document.getElementById('result')!.textContent = JSON.stringify({ status: 'passed', locale: i18n.locale, records, guiRows: panel.children.length });
      document.getElementById('result')!.dataset.status = 'passed';
    }
  } catch (e) { fail(e); cleanup(); }
}
void main();
