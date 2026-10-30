import type {BrowserMultiplayerInput} from '../../input/BrowserMultiplayerInput';
import type {GamepadControlSample} from '../../input/GamepadInputLayers';
import {InputActionMap} from '../../input/InputActionMap';
import {GuiFocusManager} from './GuiFocusManager';
import type {GuiElement} from '../components/GuiElement';
import type {GuiActionEvent} from '../GuiTypes';
import {consumeInputEvent,isInputEventConsumed} from '../../input/InputEventConsumption';
import {createGuiSyntheticPointer} from './GuiActivation';
import type {GuiInputParticipant} from './GuiInputParticipant';
import {GuiDragController} from './GuiDragController';
import {GuiPointerCursor} from './GuiPointerCursor';

interface PointerOwner {participant: GuiInputParticipant | null; target: GuiElement | null; consumed: boolean; preventDefault: boolean;}

const domains = new WeakMap<object, GuiInputDomain>();

/** Shared focus and native-key dispatch for every GUI layer on one event surface. */
export class GuiInputDomain {
  readonly focus = new GuiFocusManager();
  private readonly participants = new Map<GuiInputParticipant, number>();
  private readonly keyboardResults=new WeakMap<KeyboardEvent,boolean>();
  private readonly keyOwners=new Map<string,{participant:GuiInputParticipant|null;target:GuiElement|null;claimed:boolean;consumed:boolean}>();
  private serial = 0;
  private listening = false;
  private readonly textEvents = ['compositionstart','compositionupdate','compositionend','copy','cut','paste'] as const;
  private readonly pointerEvents = ['pointerdown','pointermove','pointerup','pointercancel'] as const;
  private readonly pointers = new Map<number,PointerOwner>();
  private readonly hovers = new Map<number,GuiInputParticipant>();
  private readonly unhandled = new Set<(event: Event) => boolean | void>();
  private readonly drag: GuiDragController;
  private readonly cursor: GuiPointerCursor;
  private mousePoint: {clientX: number; clientY: number} | null = null;
  constructor(private readonly surface?: HTMLCanvasElement | null) {
    this.cursor = new GuiPointerCursor(surface);
    this.drag = new GuiDragController(this.focus, () => this.ordered(), (id, owner) => {
      const previous = this.pointers.get(id);
      this.pointers.set(id, {participant: null, target: null, consumed: true, preventDefault: owner.preventDefault()});
      if (previous && !previous.consumed) this.emitUnhandled(createGuiSyntheticPointer('pointercancel', id));
      owner.cancelPointer(id, true);
    });
  }
  get dragSession() {return this.drag.session;}
  cancelDragFor(participant: GuiInputParticipant): void {this.drag.cancelFor(participant);}

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
      const errors: unknown[] = [];
      try {this.drag.cancelFor(participant);} catch (error) {errors.push(error);}
      try {participant.cancel();} catch (error) {errors.push(error);}
      for (const state of this.pointers.values()) if (state.participant === participant) {state.participant = null;state.target = null;}
      for (const [id,p] of this.hovers) if (p === participant) this.hovers.delete(id);
      for(const state of this.keyOwners.values())if(state.participant===participant){state.participant=null;state.target=null;state.claimed=false;state.consumed=true;}
      for(const state of this.gamepadOwners.values())if(state.participant===participant){state.participant=null;state.target=null;}
      this.participants.delete(participant);
      this.refresh();
      if (!this.participants.size) {
        this.focus.dispose();
      }
      this.releaseListeners();
      if (errors.length) throw new AggregateError(errors, 'GUI input participant cleanup failed.');
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

  private gamepadBinding:{source:BrowserMultiplayerInput;refs:number;offRaw:()=>void;offActions:()=>void}|null=null;
  private readonly gamepadOwners=new Map<string,{participant:GuiInputParticipant|null;target:GuiElement|null}>();
  get hasGamepadInput():boolean{return !!this.gamepadBinding&&!this.gamepadBinding.source.disposed;}
  attachGamepadInput(source:BrowserMultiplayerInput):()=>void {
    if(source.disposed)throw new Error('Cannot attach a disposed gamepad sampler.');
    if(this.gamepadBinding&&this.gamepadBinding.source!==source)throw new Error('One GUI input domain borrows one gamepad sampler. Release the previous attachment first.');
    if(!this.gamepadBinding){
      const offActions=source.addGamepadLayer(InputActionMap.guiNavigation(),action=>this.dispatchAction(action as GuiActionEvent['action'],'gamepad'),{capture:()=>{this.refresh();return !!this.focus.focused||!!this.focus.modal;}});
      let offRaw:()=>void;try{offRaw=source.addGamepadRoute(sample=>this.routeGamepad(sample));}catch(error){offActions();throw error;}
      this.gamepadBinding={source,refs:0,offRaw,offActions};
    }
    const binding=this.gamepadBinding;binding.refs++;let closed=false;
    return()=>{if(closed)return;closed=true;if(--binding.refs)return;if(this.gamepadBinding===binding)this.gamepadBinding=null;this.gamepadOwners.clear();try{binding.offRaw();}finally{binding.offActions();}};
  }
  cancelGamepadFor(element:GuiElement):void {for(const state of this.gamepadOwners.values())for(let node=state.target;node;node=node.parent)if(node===element){state.participant=null;state.target=null;break;}}
  private routeGamepad(sample:GamepadControlSample):boolean {
    this.refresh();const key=sample.index+':'+sample.control,held=this.gamepadOwners.get(key),active=this.ordered(),participant=held?held.participant:this.owner(this.focus.focused,active)??active.at(-1),target=held?held.target:this.focus.focused;
    const state=held??{participant:participant??null,target};let consumed=!!held;
    if(!held&&participant&&target)this.gamepadOwners.set(key,state);
    try{
      if(this.keyboardTarget(participant??null,target))consumed=(participant!.rawGamepad?.(sample,target!)??false)||consumed;
      consumed=consumed||!!this.focus.modal;
      if(!consumed&&this.gamepadOwners.get(key)===state)this.gamepadOwners.delete(key);
      return consumed;
    }catch(error){this.gamepadOwners.delete(key);throw error;}
    finally{if(sample.neutral&&this.gamepadOwners.get(key)===state)this.gamepadOwners.delete(key);}
  }

  dispatchAction(action: GuiActionEvent['action'], source: GuiActionEvent['source']): boolean {
    this.refresh();const active=this.ordered();
    if (this.drag.action(action)) return true;
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
    for(const state of this.gamepadOwners.values())if(!this.keyboardTarget(state.participant,state.target)){state.participant=null;state.target=null;}
    this.drag.refresh();
    this.refreshCursor(active);
  }

  private refreshCursor(active: readonly GuiInputParticipant[]): void {
    const point = this.mousePoint;
    if (!point) {this.cursor.restore(); return;}
    const modal = this.focus.modal;
    const participant = (modal ? this.owner(modal, active) : undefined) ?? [...active].reverse().find(p => p.pick(point));
    this.cursor.update(participant?.pick(point) ?? null);
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
  /** Native G06 responders reuse this same physical-key owner without executing Canvas editing defaults. */
  routeNativeKeyboard(participant:GuiInputParticipant,event:KeyboardEvent,target:GuiElement):boolean {
    if(!this.participants.has(participant))return false;return this.routeKeyboard(event,{participant,target});
  }
  cancelKeyboardFor(element:GuiElement):void {for(const state of this.keyOwners.values())for(let node=state.target;node;node=node.parent)if(node===element){state.participant=null;state.target=null;state.claimed=false;state.consumed=true;break;}}
  private keyboardTarget(participant:GuiInputParticipant|null,target:GuiElement|null):boolean {
    if(!participant||!target||!this.participants.has(participant)||!participant.enabled()||!participant.valid(target))return false;
    const modal=this.focus.modal;for(let node:GuiElement|null=target;node;node=node.parent)if(node===modal)return true;
    return !modal;
  }
  private routeKeyboard(event:KeyboardEvent,native?:{participant:GuiInputParticipant;target:GuiElement}):boolean {
    const previous=this.keyboardResults.get(event);if(previous!==undefined)return previous;this.keyboardResults.set(event,true);
    if(!native&&isInputEventConsumed(event))return true;
    const value=this.routeKeyboardOnce(event,native);this.keyboardResults.set(event,value);return value;
  }
  private routeKeyboardOnce(event:KeyboardEvent,native?:{participant:GuiInputParticipant;target:GuiElement}):boolean {
    this.refresh();const code=event.code||event.key,held=this.keyOwners.get(code);
    if(event.type==='keyup'){
      if(!held)return !!this.focus.modal&&!native;
      this.keyOwners.delete(code);let handled=false;
      if(held.claimed&&this.keyboardTarget(held.participant,held.target))handled=held.participant!.rawKeyboard?.(event,held.target!)??false;
      return handled||held.consumed;
    }
    if(event.repeat&&held?.claimed){
      if(this.keyboardTarget(held.participant,held.target))held.participant!.rawKeyboard?.(event,held.target!);
      return held.consumed;
    }
    const active=this.ordered(),participant=native?.participant??this.owner(this.focus.focused,active)??active.at(-1),target=native?.target??this.focus.focused;
    const state={participant:participant??null,target,claimed:false,consumed:held?.consumed===true};
    if((participant&&target)||!!this.focus.modal){
      if(!held&&this.keyOwners.size>=1024){consumeInputEvent(event);throw new Error('GUI held keyboard state exceeds the original pointer/key ceiling.');}
      this.keyOwners.set(code,state);
    }
    let claimed=false,handled=false;
    try{
      if(participant&&target&&(!event.repeat||!held)&&this.keyboardTarget(participant,target))claimed=participant.rawKeyboard?.(event,target)??false;
      handled=claimed||(!native&&(participant?.keyboard(event)||!!this.focus.modal)||false);
    }catch(error){this.keyOwners.set(code,{participant:null,target:null,claimed:false,consumed:true});consumeInputEvent(event);throw error;}
    if(this.keyOwners.get(code)===state){state.claimed=claimed&&state.participant===participant&&state.target===target;state.consumed=handled||state.consumed;}
    return native?claimed:handled||held?.consumed===true;
  }
  private onKeyDown = (event:KeyboardEvent):void => {
    if(this.routeKeyboard(event)){
      consumeInputEvent(event);const focused=this.focus.focused,preedit=focused&&'isComposing' in focused&&focused.isComposing===true;
      const owner=this.owner(focused,this.ordered());if(owner?.preventDefault()&&!event.isComposing&&!preedit)event.preventDefault();
    }else this.emitUnhandled(event);
  };
  private onKeyUp = (event:KeyboardEvent):void => {
    if(this.routeKeyboard(event)){consumeInputEvent(event);if(!event.isComposing)event.preventDefault();}else this.emitUnhandled(event);
  };
  private onBlur = (event?:Event): void => {
    if(event?.currentTarget===this.surface&&[...this.participants.keys()].some(p=>p.ownsTextTarget?.((event as FocusEvent).relatedTarget)))return;
    this.mousePoint = null;this.cursor.restore();
    for(const state of this.keyOwners.values()){state.participant=null;state.target=null;state.claimed=false;state.consumed=true;}
    for(const state of this.gamepadOwners.values()){state.participant=null;state.target=null;}
    const errors: unknown[] = [];
    try {this.drag.cancel();} catch (error) {errors.push(error);}
    for (const participant of this.participants.keys()) try {participant.cancel();} catch (error) {errors.push(error);}
    for (const [id,state] of this.pointers) if (!state.consumed) this.emitUnhandled(createGuiSyntheticPointer('pointercancel',id));
    for(const state of this.pointers.values()){state.participant=null;state.target=null;state.consumed=true;}
    this.hovers.clear();
    this.focus.blur();
    if (errors.length) throw new AggregateError(errors, 'GUI blur cleanup failed.');
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
    this.surface.addEventListener('keydown',this.onKeyDown);this.surface.addEventListener('keyup',this.onKeyUp);this.surface.addEventListener('blur',this.onBlur);
    this.surface.ownerDocument?.defaultView?.addEventListener('blur',this.onBlur);
    this.surface.ownerDocument?.defaultView?.addEventListener('pointerup',this.onOutsideTerminal);
    this.surface.ownerDocument?.defaultView?.addEventListener('pointercancel',this.onOutsideTerminal);
    this.surface.ownerDocument?.addEventListener('visibilitychange',this.onVisibility);
    for(const type of this.textEvents)this.surface.addEventListener(type,this.onText);
    for(const type of this.pointerEvents)this.surface.addEventListener(type,this.onPointer);
    this.surface.addEventListener('pointerleave',this.onPointerLeave);
    this.surface.addEventListener('lostpointercapture',this.onLostCapture);
    this.surface.addEventListener('wheel',this.onWheel,{passive:false});this.listening=true;
  }
  private releaseListeners(): void {
    if (this.participants.size || this.unhandled.size || !this.listening) return;
    this.surface?.removeEventListener('keydown',this.onKeyDown);this.surface?.removeEventListener('keyup',this.onKeyUp);this.surface?.removeEventListener('blur',this.onBlur);
    this.surface?.ownerDocument?.defaultView?.removeEventListener('blur',this.onBlur);
    this.surface?.ownerDocument?.defaultView?.removeEventListener('pointerup',this.onOutsideTerminal);
    this.surface?.ownerDocument?.defaultView?.removeEventListener('pointercancel',this.onOutsideTerminal);
    this.surface?.ownerDocument?.removeEventListener('visibilitychange',this.onVisibility);
    for(const type of this.textEvents)this.surface?.removeEventListener(type,this.onText);
    for(const type of this.pointerEvents)this.surface?.removeEventListener(type,this.onPointer);
    this.surface?.removeEventListener('pointerleave',this.onPointerLeave);
    this.surface?.removeEventListener('lostpointercapture',this.onLostCapture);this.surface?.removeEventListener('wheel',this.onWheel);
    this.mousePoint = null;this.cursor.restore();
    this.pointers.clear();this.hovers.clear();this.keyOwners.clear();this.listening=false;
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
    const event = raw as PointerEvent;
    if (event.pointerType === 'mouse') this.mousePoint = event.type === 'pointercancel' ? null : {clientX: event.clientX, clientY: event.clientY};
    try {this.routeNativePointer(raw);} catch (error) {this.mousePoint=null;this.cursor.restore();consumeInputEvent(raw); throw error;}
  };
  private onPointerLeave = (raw: Event): void => {
    if ((raw as PointerEvent).pointerType !== 'mouse') return;
    this.mousePoint = null;this.cursor.restore();
  };
  private routeNativePointer(raw: Event): void {
    const event=raw as PointerEvent,id=event.pointerId;this.refresh();
    if (this.drag.pointer(event)) {
      const state = this.pointers.get(id), consumed = !state?.participant || state.consumed;
      if (event.type === 'pointerup' || event.type === 'pointercancel') this.pointers.delete(id);
      if (consumed) {consumeInputEvent(event); if (state?.preventDefault) event.preventDefault();}
      else this.emitUnhandled(event);
      this.refresh(); return;
    }
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
      if (event.type === 'pointerdown') this.drag.arm(event, state.participant, state.target);
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
  }
  private onOutsideTerminal = (raw: Event): void => {
    if (raw.target === this.surface) return;
    const id = (raw as PointerEvent).pointerId, state = this.pointers.get(id);
    if (state && !state.participant) {this.drag.cancelPointer(id); this.pointers.delete(id);}
  };
  private onLostCapture = (raw: Event): void => {
    const id=(raw as PointerEvent).pointerId,state=this.pointers.get(id);
    this.drag.cancelPointer(id);
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
