import { AchievementRuntime, type AchievementPort, type AchievementRuleStorage } from '@haiyue/extensions/achievements';
declare const port: AchievementPort;
declare const storage: AchievementRuleStorage;
const runtime = new AchievementRuntime({ definitions: [{ id: 'win', target: 1, titleKey: 'win', descriptionKey: 'win.desc', rule: { kind: 'fact', event: 'won' } }], definitionVersion: '1', profile: 'game/guest', port, storage });
void runtime.initialize().then(() => runtime.record({ id: 'run-1', type: 'won' }));
// @ts-expect-error No executable rule expressions.
const rule: import('@haiyue/extensions/achievements').AchievementRule = { kind: 'eval', code: 'true' };
// @ts-expect-error Gameplay values must be plain numeric facts.
void runtime.record({ id: 'a', type: 'won', values: { score: () => 5 } });
void rule;
