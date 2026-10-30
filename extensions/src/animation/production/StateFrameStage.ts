import type {HyaStateMachineRuntimeV2} from '../../hya-state-machine/v2/StateMachineRuntime.js';
import type {StateMachinePose} from '../../hya-state-machine/v2/runtime-types.js';
import {ProductionFrameError, type ProductionFrameContext, type ProductionFrameStage} from './FrameTransaction.js';

/** Borrows the existing state machines; no secondary timeline, mixer or event sampler. */
type PreparedStateOwner = Pick<HyaStateMachineRuntimeV2, 'status' | 'commitPreparedFrame' | 'rollbackPreparedFrame'> & {prepareFrame(delta:number, bind?:()=>void):StateMachinePose; publishPreparedFrame?(): void; prepareTransportFrame?(delta:number, bind:(()=>void)|undefined, transport:NonNullable<ProductionFrameContext['transport']>):StateMachinePose};
export function stateFrameStage<T extends PreparedStateOwner>(id: string, machines: readonly T[],
  bind?: (machine: T, index: number, context: ProductionFrameContext) => void): ProductionFrameStage {
  const owners = Object.freeze([...machines]);
  if (new Set(owners).size !== owners.length) throw new ProductionFrameError('E_HYA_RUNTIME_STAGE', id, 'a state machine cannot join the same frame twice');
  let active: readonly Readonly<{owner: T; pose: StateMachinePose}>[] | undefined;
  const cancel = (): void => {
    const steps = active; active = undefined;
    if (!steps) return;
    const failures: unknown[] = [];
    for (const step of [...steps].reverse()) {
      // Disposing a runtime already retires its staged frame. Never resurrect it.
      if (step.owner.status === 'disposed') continue;
      try {step.owner.rollbackPreparedFrame(step.pose);} catch (error) {failures.push(error);}
    }
    if (failures.length) throw new AggregateError(failures, 'State frame rollback failed');
  };
  return Object.freeze({id, phase: 'state-timeline', prepare(context: ProductionFrameContext) {
    if (active) throw new ProductionFrameError('E_HYA_RUNTIME_REENTRANT', id, 'state stage already has a prepared frame');
    const steps: {owner: T; pose: StateMachinePose}[] = []; active = steps;
    try {
      for (const [index, owner] of owners.entries()) {
        if (context.transport && !owner.prepareTransportFrame) throw new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT',id,'prepared transport needs its original state controller adapter');
        const pose = context.transport ? owner.prepareTransportFrame!(context.transport.deltaSeconds,()=>bind?.(owner,index,context),context.transport) : owner.prepareFrame(context.request.deltaSeconds, () => bind?.(owner, index, context));
        steps.push({owner, pose});
      }
      return Object.freeze({value: Object.freeze(steps.map(step => step.pose)), commit: () => {
        for (const step of steps) step.owner.commitPreparedFrame(step.pose);
        active = undefined;
      }, rollback: cancel, publish: () => {
        const failures: unknown[] = [];
        for (const owner of owners) {try {owner.publishPreparedFrame?.();} catch (error) {failures.push(error);}}
        if (failures.length) throw new AggregateError(failures, 'State frame publication failed');
      }});
    } catch (error) {
      try {cancel();} catch (rollbackError) {throw new AggregateError([error, rollbackError], 'State preparation and rollback failed');}
      throw error;
    }
  }, dispose: cancel});
}
