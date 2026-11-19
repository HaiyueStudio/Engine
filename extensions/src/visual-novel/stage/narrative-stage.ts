import type { NarrativeRuntime } from '../../narrative/NarrativeRuntime';
import type { NarrativeActionHandler } from '../../narrative/actions';
import type { StoryDefinition } from '../story/types';
import type { VisualNovelStage } from './VisualNovelStage';

/** Register this handler under visualNovel.stage in connectNarrativeActions alongside the game's handlers. */
export function stageActionHandler(
  runtime: NarrativeRuntime, stage: VisualNovelStage, cues: StoryDefinition['cues'], reducedMotion: () => boolean,
): NarrativeActionHandler {
  return async (request, signal) => {
    const view = runtime.view;
    if (signal.aborted || view?.action?.id !== request.id) return;
    if (!Object.hasOwn(cues, view.nodeId)) throw new Error(`No compiled stage cues for "${view.nodeId}".`);
    await stage.run({
      sessionId: runtime.save().runId, actionId: request.id, cues: cues[view.nodeId]!, reducedMotion: reducedMotion(), signal,
    });
  };
}
