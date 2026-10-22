import {GuiFocusManager} from './GuiFocusManager';
import type {GuiElement} from '../components/GuiElement';
import type {GuiRect,GuiActionEvent} from '../GuiTypes';
import {consumeInputEvent,isInputEventConsumed} from '../../input/InputEventConsumption';
import {createGuiSyntheticPointer} from './GuiActivation';

export interface GuiInputParticipant {
  roots(): readonly GuiElement[];
  enabled(): boolean;
  keyboard(event: KeyboardEvent): boolean;
  action(action: GuiActionEvent['action'], source: GuiActionEvent['source']): boolean;
  text(event: Event): boolean;
  preventDefault(): boolean;
  cancel(): void;
  rect(element: GuiElement): Readonly<GuiRect>;
  pick(event: {clientX:number;clientY:number}): GuiElement | null;
  pointer(event: PointerEvent, hit?: GuiElement | null): boolean;
  wheel(event: WheelEvent): boolean;
  valid(element: GuiElement): boolean;
  cancelPointer(id: number): void;
  leavePointer(event: PointerEvent): void;
  ownsTextTarget?(target:EventTarget|null):boolean;
}

interface PointerOwner {participant: GuiInputParticipant | null; target: GuiElement | null; consumed: boolean; preventDefault: boolean;}

const domains = new WeakMap<object, GuiInputDomain>();

/** Shared focus and native-key dispatch for every GUI layer on one event surface. */
export class GuiInputDomain {
  readonly focus = new GuiFocusManager();
  private readonly participants = new Map<GuiInputParticipant, number>();
  private serial = 0;
  private listening = false;
  private readonly textEvents = ['compositionstart','compositionupdate','compositionend','copy','cut','paste'] as const;
  private readonly pointerEvents = ['pointerdown','pointermove','pointerup','pointercancel'] as const;
  private readonly pointers = new Map<number,PointerOwner>();
  private readonly hovers = new Map<number,GuiInputParticipant>();
  private readonly unhandled = new Set<(event: Event) => boolean | void>();
  constructor(private readonly surface?: HTMLCanvasElement | null) {}

  static for(owner: object, surface?: HTMLCanvasElement | null): GuiInputDomain {
    let domain = domains.get(owner);
    if (!domain) { domain = new GuiInputDomain(surface); domains.set(owner, domain); }
    return domain;
  }

  register(participant: GuiInputParticipant): () => void {
    this.participants.set(participant, ++this.serial);
    this.listen();
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      participant.cancel();
      for (const state of this.pointers.values()) if (state.participant === participant) {state.participant = null;state.target = null;}
      for (const [id,p] of this.hovers) if (p === participant) this.hovers.delete(id);
      this.participants.delete(participant);
      this.refresh();
      if (!this.participants.size) {
        this.focus.dispose();
      }
      this.releaseListeners();
    };
  }

  subscribeUnhandled(callback: (event: Event) => boolean | void): () => void {
    this.unhandled.add(callback);this.listen();
    return () => {this.unhandled.delete(callback);this.releaseListeners();};
  }

  /** Preflight follows visual layer order even when a cached GUI is not recorded again. */
  touch(participant: GuiInputParticipant): void {
    if (this.participants.has(participant)) this.participants.set(participant, ++this.serial);
  }

  dispatchAction(action: GuiActionEvent['action'], source: GuiActionEvent['source']): boolean {
    this.refresh();const active=this.ordered();
    return (this.owner(this.focus.focused,active)??active.at(-1))?.action(action,source)??false;
  }

  refresh(): void {
    const active = this.ordered(), roots = active.flatMap(p => [...p.roots()]);
    this.focus.setRoots([...new Set(roots)], element => {
      const owner = this.owner(element, active);
      return owner ? owner.rect(element) : element.rect;
    });
    const modal=this.focus.modal;
    for (const [id,state] of this.pointers) {
      let inside=!modal;
      for(let node=state.target;node&&!inside;node=node.parent)if(node===modal)inside=true;
      if (state.participant && (!active.includes(state.participant) || !state.target || !state.participant.valid(state.target) || !inside)) {
        state.participant.cancelPointer(id);state.participant=null;state.target=null;
      }
      if (modal && !inside && !state.consumed) {this.emitUnhandled(createGuiSyntheticPointer('pointercancel',id));state.consumed=true;}
    }
  }

  private ordered(): GuiInputParticipant[] {
    return [...this.participants].filter(([p]) => p.enabled()).sort((a,b) => a[1]-b[1]).map(([p]) => p);
  }
  private owner(element: GuiElement | null, ordered: readonly GuiInputParticipant[]): GuiInputParticipant | undefined {
    if (!element) return undefined;
    let root = element;
    while (root.parent) root = root.parent;
    return [...ordered].reverse().find(p => p.roots().includes(root));
  }
  private onKeyDown = (event: KeyboardEvent): void => {
    this.refresh();
    const active = this.ordered(), owner = this.owner(this.focus.focused, active) ?? active.at(-1);
    if (owner?.keyboard(event) || this.focus.modal) {
      consumeInputEvent(event);
      const focused=this.focus.focused,preedit=focused&&'isComposing' in focused&&focused.isComposing===true;
      if(owner?.preventDefault()&&!event.isComposing&&!preedit)event.preventDefault();
    }
    else this.emitUnhandled(event);
  };
  private onBlur = (event?:Event): void => {
    if(event?.currentTarget===this.surface&&[...this.participants.keys()].some(p=>p.ownsTextTarget?.((event as FocusEvent).relatedTarget)))return;
    for (const participant of this.participants.keys()) participant.cancel();
    for (const [id,state] of this.pointers) if (!state.consumed) this.emitUnhandled(createGuiSyntheticPointer('pointercancel',id));
    for(const state of this.pointers.values()){state.participant=null;state.target=null;state.consumed=true;}
    this.hovers.clear();
    this.focus.blur();
  };
  private onVisibility = (): void => {if(this.surface?.ownerDocument?.hidden)this.onBlur();};
  private onText = (event: Event): void => {
    this.refresh();
    const active = this.ordered(), owner = this.owner(this.focus.focused, active);
    if (owner?.text(event) || this.focus.modal) {consumeInputEvent(event);if(owner?.preventDefault())event.preventDefault();}
    else this.emitUnhandled(event);
  };

  private listen(): void {
    if (this.listening || !this.surface) return;
    this.surface.addEventListener('keydown',this.onKeyDown);this.surface.addEventListener('blur',this.onBlur);
    this.surface.ownerDocument?.defaultView?.addEventListener('blur',this.onBlur);
    this.surface.ownerDocument?.addEventListener('visibilitychange',this.onVisibility);
    for(const type of this.textEvents)this.surface.addEventListener(type,this.onText);
    for(const type of this.pointerEvents)this.surface.addEventListener(type,this.onPointer);
    this.surface.addEventListener('lostpointercapture',this.onLostCapture);
    this.surface.addEventListener('wheel',this.onWheel,{passive:false});this.listening=true;
  }
  private releaseListeners(): void {
    if (this.participants.size || this.unhandled.size || !this.listening) return;
    this.surface?.removeEventListener('keydown',this.onKeyDown);this.surface?.removeEventListener('blur',this.onBlur);
    this.surface?.ownerDocument?.defaultView?.removeEventListener('blur',this.onBlur);
    this.surface?.ownerDocument?.removeEventListener('visibilitychange',this.onVisibility);
    for(const type of this.textEvents)this.surface?.removeEventListener(type,this.onText);
    for(const type of this.pointerEvents)this.surface?.removeEventListener(type,this.onPointer);
    this.surface?.removeEventListener('lostpointercapture',this.onLostCapture);this.surface?.removeEventListener('wheel',this.onWheel);
    this.pointers.clear();this.hovers.clear();this.listening=false;
  }
  private emitUnhandled(event: Event): void {
    for (const callback of [...this.unhandled]) {
      if(!this.unhandled.has(callback))continue;
      if (isInputEventConsumed(event)) break;
      if (callback(event) === true) consumeInputEvent(event);
    }
  }
  private blocked(target: GuiElement | null): boolean {
    for(let node=target;node;node=node.parent)if(node.pointerFilter==='stop')return true;
    return false;
  }
  private onPointer = (raw: Event): void => {
    const event=raw as PointerEvent,id=event.pointerId;this.refresh();
    const active=this.ordered(),modal=this.focus.modal;
    let state=this.pointers.get(id);
    if (event.type==='pointerdown') {
      state?.participant?.cancelPointer(id);
      if(state&&!state.consumed)this.emitUnhandled(createGuiSyntheticPointer('pointercancel',id));
      const participant=(modal?this.owner(modal,active):undefined)??[...active].reverse().find(p=>p.pick(event));
      const target=participant?.pick(event)??null;
      state={participant:participant??null,target,consumed:!!modal||this.blocked(target),preventDefault:participant?.preventDefault()??false};
      this.pointers.set(id,state);
    }
    const terminal=event.type==='pointerup'||event.type==='pointercancel';
    // Own release may synchronously emit lostpointercapture; it must not cancel twice.
    if (terminal)this.pointers.delete(id);
    if (state) {
      const sharedWithScene=!state.consumed;
      if (state.participant) {
        state.consumed=state.participant.pointer(event,event.type==='pointerdown'?state.target:undefined)||state.consumed;
      }
      if(sharedWithScene&&state.consumed&&event.type!=='pointerdown')this.emitUnhandled(createGuiSyntheticPointer('pointercancel',id));
      if (state.preventDefault && state.consumed)event.preventDefault();
      if (state.consumed)consumeInputEvent(event);else this.emitUnhandled(event);
    } else if (event.type==='pointermove') {
      const participant=(modal?this.owner(modal,active):undefined)??[...active].reverse().find(p=>p.pick(event));
      const previous=this.hovers.get(id);
      if(previous&&previous!==participant)previous.leavePointer(event);
      if(participant)this.hovers.set(id,participant);else this.hovers.delete(id);
      const handled=participant?.pointer(event)??false;
      if(handled||modal||this.blocked(participant?.pick(event)??null)) {
        consumeInputEvent(event);if(participant?.preventDefault())event.preventDefault();
      }else this.emitUnhandled(event);
    } else this.emitUnhandled(event);
    if(terminal&&event.pointerType==='touch')this.hovers.delete(id);
    this.refresh();
  };
  private onLostCapture = (raw: Event): void => {
    const id=(raw as PointerEvent).pointerId,state=this.pointers.get(id);
    if(!state)return;
    state.participant?.cancelPointer(id);state.participant=null;state.target=null;
    if(!state.consumed)this.emitUnhandled(createGuiSyntheticPointer('pointercancel',id));
    state.consumed=true;
  };
  private onWheel = (raw: Event): void => {
    const event=raw as WheelEvent;this.refresh();const active=this.ordered(),modal=this.focus.modal;
    const participant=(modal?this.owner(modal,active):undefined)??[...active].reverse().find(p=>p.pick(event));
    const handled=participant?.wheel(event)??false;
    if(handled||modal||this.blocked(participant?.pick(event)??null)) {consumeInputEvent(event);if(participant?.preventDefault())event.preventDefault();}
    else this.emitUnhandled(event);
  };
}
