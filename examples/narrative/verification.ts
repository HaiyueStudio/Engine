import type { HaiyueEngine } from '@haiyue/engine';
import type { GuiRoot } from '@haiyue/engine/gui';
import type { I18n } from '@haiyue/extensions/i18n';
import type { NarrativeRuntime, NarrativeGui, NarrativeActionConnection } from '@haiyue/extensions/narrative';

export async function verifyNarrative(engine: HaiyueEngine, root: GuiRoot, story: NarrativeRuntime, gui: NarrativeGui, i18n: I18n, win: () => void, actions: NarrativeActionConnection) {
  engine.device.pushErrorScope('validation');
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const frame = () => new Promise<void>(resolve => engine.once('after-update', () => resolve()));
  const canvas = engine.canvas!;
  const capture = canvas.setPointerCapture.bind(canvas), release = canvas.releasePointerCapture.bind(canvas);
  canvas.setPointerCapture = id => { if (id !== 8157) capture(id); };
  canvas.releasePointerCapture = id => { if (id !== 8157) release(id); };
  const click = async (id: string) => {
    await frame(); await frame();
    const node = root.findById(id); assert(node, `Missing GUI button ${id}`);
    const rect = canvas.getBoundingClientRect(), target = node!;
    for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new PointerEvent(type, { pointerId: 8157, pointerType: 'touch', isPrimary: true, button: 0, bubbles: true, clientX: rect.left + target.rect.x + target.rect.width / 2, clientY: rect.top + target.rect.y + target.rect.height / 2 }));
    await frame(); await frame();
  };
  const settle = async () => { for (let i = 0; i < 4; i++) await frame(); if (actions.error) throw actions.error; await gui.ready; if (gui.imageError) throw gui.imageError; };
  const endings: string[] = [];
  try {
    await click(`${gui.panel.id}:continue`); assert(story.view?.nodeId === 'decision', 'GUI advance');
    const saved = JSON.parse(JSON.stringify(story.save()));
    await click(`${gui.panel.id}:choice:rescue`); assert(story.view?.nodeId === 'battle', 'Choice enters host state');
    const pending = story.save(), oldToken = story.view!.action!.token;
    story.restore(pending); await settle(); assert(story.view!.action!.token === oldToken, 'Durable action token');
    await click('battle-win'); await settle(); assert(story.view?.ending === 'together', 'Battle return'); endings.push(story.view!.ending!);
    const afterReward = story.save(); story.restore(afterReward); await settle(); assert(story.view!.variables.medals === 1, 'Restore must not re-award');
    story.restore(saved); await settle(); await click(`${gui.panel.id}:choice:signal`); await click(`${gui.panel.id}:continue`); await settle(); assert(story.view?.ending === 'together', 'Signal route'); endings.push(story.view!.ending!);
    story.restore(saved); await settle(); await click(`${gui.panel.id}:choice:leave`); await settle(); assert(story.view?.ending === 'alone', 'Leave route'); endings.push(story.view!.ending!);
    await i18n.setLocale('en'); await settle();
    story.restore(saved); await settle(); await click(`${gui.panel.id}:choice:rescue`); await settle(); win(); await settle();
    const snapshot = story.save();
    const error = await engine.device.popErrorScope(); if (error) throw new Error(error.message);
    return { passed: true, endings, locale: i18n.locale, nodeId: story.view!.nodeId, medals: snapshot.variables.medals, checks: ['GUI pointer choices', 'three branches', 'two endings', 'host state round trip', 'pending action restore', 'effect non-replay', 'localized text and image', 'GPU validation'] };
  } finally { canvas.setPointerCapture = capture; canvas.releasePointerCapture = release; }
}
