import { NarrativeRuntime, NarrativeGui, connectNarrativeActions, type NarrativeDefinition, type NarrativeCondition } from '@haiyue/extensions/narrative';
import { GuiElement } from '@haiyue/engine/gui';
import { I18n } from '@haiyue/extensions/i18n';
const story: NarrativeDefinition = { schemaVersion: 1, id: 'test', version: '1', start: 'end', variables: { won: false }, nodes: { end: { type: 'end', ending: 'safe', textKey: 'safe' } } };
const runtime = new NarrativeRuntime(story);
runtime.start('unique-run'); runtime.restore(JSON.parse(JSON.stringify(runtime.save())));
const view = new NarrativeGui(runtime, { parent: new GuiElement(), i18n: new I18n({ locale: 'en', fallbackLocale: 'en' }), continueKey: 'next', waitingKey: 'wait' });
connectNarrativeActions(runtime, { fight: async (_request, signal) => { signal.throwIfAborted(); return { won: true }; } }).dispose();
view.dispose();
// @ts-expect-error No executable expressions in story conditions.
const condition: NarrativeCondition = { op: 'eval', code: 'true' };
// @ts-expect-error Action results must be JSON primitive variables.
runtime.completeAction(1, { won: () => true });
void condition;
