import {GuiElement} from '../components/GuiElement';
import type {GuiDragSource, GuiDropTarget, GuiDragSession} from '../GuiDragTypes';
import type {GuiActionEvent} from '../GuiTypes';
import type {GuiInputParticipant} from './GuiInputParticipant';
import type {GuiFocusManager} from './GuiFocusManager';
import type {GuiDragPreview} from './GuiDragPreview';
import {activeGuiNodes, guiDragSourceFrom, guiScrollAncestor, guiWithin} from './GuiDragGeometry';
import {guiDirectionalTarget} from './GuiNavigation';

type Point = Readonly<{x: number; y: number}>;
interface Candidate {owner: GuiInputParticipant; element: GuiElement; source: GuiDragSource; pointerId: number; start: Point; touchScroll: boolean;}
interface Target {owner: GuiInputParticipant; element: GuiElement; protocol: GuiDropTarget;}
interface HandleState {targetId: string | null; cancel: (() => void) | null;}
function createDragHandle(sourceId: string, pointerId: number | undefined, state: HandleState): GuiDragSession {
  return Object.freeze({sourceId, ...(pointerId === undefined ? {} : {pointerId}),
    get targetId() {return state.targetId;}, cancel() {state.cancel?.();}});
}
interface Drag {
  owner: GuiInputParticipant; element: GuiElement; source: GuiDragSource; pointerId?: number;
  handle: GuiDragSession; data: unknown; ready: boolean; modal: GuiElement | null; point: Point;
  client: Point | null;
  handleState: HandleState;
  target: Target | null; accepted: boolean; preview: GuiElement | null;
  overlay: GuiDragPreview | null; overlayOwner: GuiInputParticipant | null;
}

/** One transactional drag per existing input domain; payloads never enter a serializer. */
export class GuiDragController {
  private candidate: Candidate | null = null;
  private current: Drag | null = null;
  private checking = false;
  private finishing = false;

  constructor(private readonly focus: GuiFocusManager,
      private readonly participants: () => readonly GuiInputParticipant[],
      private readonly claimPointer: (id: number, owner: GuiInputParticipant) => void) {}
  get session(): GuiDragSession | null {return this.current?.handle ?? null;}

  arm(event: PointerEvent, owner: GuiInputParticipant | null, hit: GuiElement | null): void {
    if (this.current || this.candidate || this.finishing || !owner || event.button !== 0) return;
    const element = guiDragSourceFrom(hit), source = element?.dragSource;
    if (!element || !source || !owner.valid(element) || !guiWithin(element, this.focus.modal)) return;
    this.candidate = {owner, element, source, pointerId: event.pointerId,
      start: {x: event.clientX, y: event.clientY},
      touchScroll: event.pointerType === 'touch' && source.touchGesture !== 'drag' && !!guiScrollAncestor(element)};
  }

  /** True suppresses ordinary click/scroll dispatch for only this pointer sequence. */
  pointer(event: PointerEvent): boolean {
    const drag = this.current;
    if (this.checking && drag?.pointerId === event.pointerId) return true;
    if (drag && drag.pointerId === undefined && event.type === 'pointerdown') {this.end(drag); return false;}
    if (drag && drag.pointerId === event.pointerId) {
      if (event.type === 'pointercancel') {this.end(drag); return true;}
      const point = drag.owner.hostPoint(event);
      if (!point) {this.end(drag); return true;}
      drag.point = point;
      drag.client = {x: event.clientX, y: event.clientY};
      if (event.type === 'pointerup') this.drop(drag);
      else if (event.type === 'pointermove') {this.probe(drag); if (this.current === drag) drag.overlay?.move(point);}
      return true;
    }
    const candidate = this.candidate;
    if (!candidate || candidate.pointerId !== event.pointerId) return false;
    if (!this.validCandidate(candidate)) {this.candidate = null; return false;}
    if (event.type === 'pointercancel') {this.candidate = null; return false;}
    if (event.type !== 'pointermove' && event.type !== 'pointerup') return false;
    const dx = event.clientX - candidate.start.x, dy = event.clientY - candidate.start.y;
    if (Math.hypot(dx, dy) < 6) {if (event.type === 'pointerup') this.candidate = null; return event.type === 'pointermove';}
    this.candidate = null;
    if (candidate.touchScroll && Math.abs(dy) >= Math.abs(dx)) return false;
    const point = candidate.owner.hostPoint(event);
    if (!point) return false;
    const started = this.begin(candidate.owner, candidate.element, candidate.source, point, event.pointerId, {x: event.clientX, y: event.clientY});
    if (started && this.current === started) {
      if (event.type === 'pointerup') this.drop(started); else this.probe(started);
    }
    return true;
  }

  action(action: GuiActionEvent['action']): boolean {
    if (this.finishing || this.checking) return true;
    const drag = this.current;
    if (drag) {
      if (action === 'cancel') this.end(drag);
      else if (drag.ready && drag.pointerId === undefined) {
        if (action === 'confirm') this.drop(drag);
        else this.navigate(drag, action);
      }
      return true;
    }
    if (action !== 'confirm') return false;
    const element = this.focus.focused, source = element?.dragSource;
    if (!element || !source) return false;
    const owner = [...this.participants()].reverse().find(participant => participant.valid(element));
    if (!owner || !guiWithin(element, this.focus.modal)) return false;
    const rect = owner.rect(element);
    this.candidate = null;
    this.begin(owner, element, source, {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2});
    return true;
  }

  refresh(): void {
    if (this.candidate && !this.validCandidate(this.candidate)) this.candidate = null;
    const drag = this.current;
    if (!drag || this.checking || !drag.ready) return;
    if (!this.valid(drag) || (drag.target && !this.validTarget(drag.target))) {this.end(drag); return;}
    if (drag.pointerId === undefined) {
      if (drag.target) {
        const point = this.anchor(drag.target);
        if (point) {drag.point = point; this.probe(drag); drag.overlay?.move(point);}
        else this.setTarget(drag, null, false);
      }
    } else {
      const point = drag.client ? drag.owner.hostPoint({clientX: drag.client.x, clientY: drag.client.y}) : null;
      if (!point) {this.end(drag); return;}
      drag.point = point; this.probe(drag);
      if (this.current === drag) drag.overlay?.move(point);
    }
  }
  cancel(): void {this.candidate = null; if (this.current) this.end(this.current);}
  cancelPointer(id: number): void {
    if (this.candidate?.pointerId === id) this.candidate = null;
    if (this.current?.pointerId === id) this.end(this.current);
  }
  cancelFor(owner: GuiInputParticipant): void {
    if (this.candidate?.owner === owner) this.candidate = null;
    const drag = this.current;
    if (drag && (drag.owner === owner || drag.target?.owner === owner || drag.overlayOwner === owner)) this.end(drag);
  }

  private validCandidate(candidate: Candidate): boolean {
    return candidate.owner.enabled() && candidate.owner.valid(candidate.element) && candidate.element.dragSource === candidate.source && guiWithin(candidate.element, this.focus.modal);
  }
  private valid(drag: Drag): boolean {
    return this.current === drag && drag.owner.enabled() && drag.owner.valid(drag.element) &&
      drag.element.dragSource === drag.source && this.focus.modal === drag.modal &&
      (!drag.overlayOwner || (drag.overlayOwner.enabled() && drag.overlayOwner.preview() === drag.overlay));
  }
  private validTarget(target: Target): boolean {
    return target.owner.enabled() && target.owner.valid(target.element) && target.element.dropTarget === target.protocol;
  }
  private begin(owner: GuiInputParticipant, element: GuiElement, source: GuiDragSource, point: Point, pointerId?: number, client: Point | null = null): Drag | null {
    if (this.current || this.finishing) return null;
    const handleState: HandleState = {targetId: null, cancel: null};
    const handle = createDragHandle(element.id, pointerId, handleState);
    const drag: Drag = {owner, element, source, handle, handleState, ...(pointerId === undefined ? {} : {pointerId}),
      data: undefined, ready: false, modal: this.focus.modal, point, client, target: null, accepted: false, preview: null, overlay: null, overlayOwner: null};
    handleState.cancel = () => {if (this.current === drag) this.end(drag);};
    this.current = drag;
    try {
      if (pointerId !== undefined) this.claimPointer(pointerId, owner);
      if (!this.valid(drag)) {if (this.current === drag) this.end(drag); return null;}
      drag.data = source.getData();
      if (!this.valid(drag)) {if (this.current === drag) this.end(drag); return null;}
      if (source.createPreview) {
        const preview = source.createPreview();
        if (!(preview instanceof GuiElement)) throw new TypeError('GUI drag preview factory must return an element synchronously.');
        if (this.current !== drag) {source.disposePreview?.(preview); return null;}
        drag.preview = preview;
        if (guiWithin(element, preview)) throw new TypeError('A drag source or its ancestor cannot be used as its preview.');
        const host = this.participants().at(-1);
        if (!host?.preview()) throw new TypeError('A drag preview requires a topmost full-canvas GUI overlay region.');
        drag.overlayOwner = host; drag.overlay = host.preview();
        drag.overlay!.show(preview, owner.rootFor(element), point);
      }
      drag.ready = true;
      if (!this.valid(drag)) {if (this.current === drag) this.end(drag); return null;}
      return drag;
    } catch (error) {this.fail(drag, error);}
  }

  private resolve(drag: Drag): Target | null {
    const active = this.participants(), modal = this.focus.modal;
    const owner = modal ? [...active].reverse().find(participant => participant.valid(modal)) : undefined;
    const ordered = owner ? [owner] : [...active].reverse();
    for (const participant of ordered) {
      const hit = participant.pickHost(drag.point);
      if (!hit) continue;
      for (let element: GuiElement | null = hit; element; element = element.parent)
        if (element.dropTarget && guiWithin(element, modal)) return {owner: participant, element, protocol: element.dropTarget};
      return null; // A visible GUI layer occludes targets underneath it.
    }
    return null;
  }
  private position(drag: Drag, target: Target): Point | null {
    const point = target.owner.localPoint(drag.point);
    return point?.inside ? Object.freeze({x: point.x - target.element.rect.x, y: point.y - target.element.rect.y}) : null;
  }
  private same(a: Target | null, b: Target | null): boolean {return a?.owner === b?.owner && a?.element === b?.element && a?.protocol === b?.protocol;}
  private accepts(drag: Drag, target: Target): boolean {
    const position = this.position(drag, target);
    if (!position) return false;
    const previous = this.checking; this.checking = true;
    try {return target.protocol.canDrop(drag.data, position) === true;}
    finally {this.checking = previous;}
  }
  private probe(drag: Drag): void {
    if (this.current !== drag || !drag.ready || this.checking) return;
    this.checking = true;
    try {
      if (!this.valid(drag)) {this.end(drag); return;}
      const target = this.resolve(drag), accepted = !!target && this.accepts(drag, target);
      if (!this.valid(drag)) {if (this.current === drag) this.end(drag); return;}
      if (target && (!this.validTarget(target) || !this.same(this.resolve(drag), target))) {this.end(drag); return;}
      this.setTarget(drag, target, accepted);
      if (this.current === drag && (!this.valid(drag) || (drag.target && !this.validTarget(drag.target)))) this.end(drag);
    } catch (error) {this.fail(drag, error);}
    finally {this.checking = false;}
  }
  private setTarget(drag: Drag, target: Target | null, accepted: boolean): void {
    if (this.current !== drag) return;
    if (this.same(drag.target, target)) {
      if (drag.accepted !== accepted) {drag.accepted = accepted; target?.protocol.onHoverChange?.(true, accepted);}
      return;
    }
    const previous = drag.target; drag.target = null; drag.handleState.targetId = null; drag.accepted = false;
    previous?.protocol.onHoverChange?.(false, false);
    if (this.current !== drag) return;
    drag.target = target; drag.handleState.targetId = target?.element.id ?? null; drag.accepted = accepted;
    target?.protocol.onHoverChange?.(true, accepted);
  }
  private drop(drag: Drag): void {
    if (this.current !== drag || !drag.ready) return;
    try {
      if (!this.valid(drag)) {this.end(drag); return;}
      const target = this.resolve(drag);
      if (!target || !this.accepts(drag, target)) {this.end(drag); return;}
      const position = this.position(drag, target);
      if (!position || !this.valid(drag) || !this.validTarget(target) || !this.same(this.resolve(drag), target)) {if (this.current === drag) this.end(drag); return;}
      this.end(drag, () => target.protocol.drop(drag.data, position));
    } catch (error) {this.fail(drag, error);}
  }

  private anchor(target: Target): Point | null {
    const rect = target.owner.visibleRect(target.element);
    return rect ? {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2} : null;
  }
  private navigate(drag: Drag, action: Exclude<GuiActionEvent['action'], 'confirm' | 'cancel'>): void {
    try {
      const entries = new Map<GuiElement, Target>();
      for (const owner of this.participants()) for (const element of activeGuiNodes(owner.roots())) {
        if (!element.dropTarget || !guiWithin(element, drag.modal)) continue;
        const target = {owner, element, protocol: element.dropTarget};
        const previous = this.checking; this.checking = true;
        let accepted: boolean;
        try {accepted = target.protocol.canDrop(drag.data, Object.freeze({x: element.rect.width / 2, y: element.rect.height / 2})) === true;}
        finally {this.checking = previous;}
        if (!this.valid(drag)) {if (this.current === drag) this.end(drag); return;}
        if (accepted && this.validTarget(target)) entries.set(element, target);
      }
      const targets = [...entries.values()]; if (!targets.length) {this.setTarget(drag, null, false); return;}
      let chosen: Target | undefined;
      if (action === 'next' || action === 'previous') {
        const index = targets.findIndex(target => target.element === drag.target?.element);
        chosen = targets[index < 0 ? action === 'previous' ? targets.length - 1 : 0 : (index + (action === 'previous' ? -1 : 1) + targets.length) % targets.length];
      } else {
        const current = drag.target?.element ?? drag.element;
        const element = guiDirectionalTarget(current, targets.map(target => target.element), action,
          element => (entries.get(element)?.owner ?? drag.owner).rect(element), current.focusOptions.neighbours?.[action]);
        chosen = element ? entries.get(element) : drag.target ? undefined : targets[0];
      }
      if (!chosen) return;
      chosen.owner.reveal(chosen.element);
      const point = this.anchor(chosen);
      if (point) {drag.point = point; this.probe(drag); if (this.current === drag) drag.overlay?.move(point);}
      else this.setTarget(drag, null, false);
    } catch (error) {this.fail(drag, error);}
  }
  private end(drag: Drag, commit?: () => void): void {
    if (this.current !== drag) return;
    this.current = null; this.candidate = null; this.finishing = true;
    drag.handleState.cancel = null; drag.handleState.targetId = null;
    const errors: unknown[] = []; let accepted = false;
    const run = (work: () => void): void => {try {work();} catch (error) {errors.push(error);}};
    if (commit) run(() => {commit(); accepted = true;});
    const target = drag.target; drag.target = null; drag.accepted = false;
    run(() => target?.protocol.onHoverChange?.(false, false));
    run(() => drag.overlay?.hide(drag.preview ?? undefined));
    if (drag.preview) run(() => drag.source.disposePreview?.(drag.preview!));
    if (drag.pointerId !== undefined) run(() => drag.owner.releasePointer(drag.pointerId!));
    run(() => drag.source.onEnd?.(accepted));
    this.finishing = false;
    if (errors.length) throw new AggregateError(errors, 'GUI drag callbacks or cleanup failed.');
  }
  private fail(drag: Drag, error: unknown): never {
    if (this.current === drag) {try {this.end(drag);} catch (cleanup) {throw new AggregateError([error, cleanup], 'GUI drag failed; cleanup also reported an error.');}}
    throw error;
  }
}
