import {parseAnimation} from '../parser.js';
import {parseResponsiveLayoutDocument} from '../layout2d/parameterized/parser.js';
import {parseHyaDataBinding} from '../data-binding/parser.js';
import {parseHyaInteraction} from '../interaction/parser.js';
import {parseHyaSemantics} from '../semantics/parser.js';
import {parseHyaAudioEvents} from '../audio/parser.js';
import {parseHyaStateMachineV2} from '../state-machine-v2/parser.js';
import type {HyaCompositionPartValidator} from './types.js';
import type {AnimationDocument} from '../types.js';

/** These validate formats only. They do not advertise renderer or host capabilities. */
export const compositionPartValidators: ReadonlyMap<string, HyaCompositionPartValidator> = new Map<string, HyaCompositionPartValidator>([
  ['org.haiyue.animation-core@1', value => {parseAnimation(value as unknown as AnimationDocument);} ],
  ['org.haiyue.layout-2d@1', value => {parseResponsiveLayoutDocument(value);} ],
  ['org.haiyue.data-binding@1', value => {parseHyaDataBinding(value);} ],
  ['org.haiyue.interaction@1', value => {parseHyaInteraction(value);} ],
  ['org.haiyue.semantics@1', value => {parseHyaSemantics(value);} ],
  ['org.haiyue.audio-events@1', value => {parseHyaAudioEvents(value);} ],
  ['org.haiyue.animation-state-machine@2', value => {parseHyaStateMachineV2(value);} ],
]);
