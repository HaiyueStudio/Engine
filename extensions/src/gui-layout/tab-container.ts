import {GuiButton, GuiDirtyFlags, GuiElement} from '@haiyue/engine/gui';
import type {GuiFocusManager} from '@haiyue/engine/gui';
import {LayoutError} from '../layout.js';
import {createGuiContainer, ownContentFrame, setContainerStyle} from './presets.js';
import {finiteNonnegative, firstFocusable, stateRecord, within} from './panel-state.js';
import type {GuiTabContainerOptions, GuiTabPage, GuiTabHeaderOptions} from './panel-types.js';
import {headerStyle} from './panel-content.js';
import {layoutStyleVisible} from './visibility.js';
import {GuiCleanup} from './panel-cleanup.js';
import {surface,show,choice} from '../gui-common/composite.js';

interface PageEntry {
  page: GuiTabPage;
  hidden: boolean;
  header: GuiElement;
  button: GuiButton;
  close: GuiButton | null;
  lastFocus: GuiElement | null;
  release: () => void;
  indicator:GuiElement;
}

/** Page business objects remain borrowed. Only the active page is attached to the GUI tree. */
export class GuiTabContainer {
  readonly element: GuiElement;
  readonly header: GuiElement;
  readonly body: GuiElement;
  private entries: PageEntry[] = [];
  private current: string | null = null;
  private readonly focus: GuiFocusManager | undefined;
  private onActiveChange: ((id: string | null) => void) | undefined;
  private onClose: ((id: string) => boolean | void) | undefined;
  private disposed = false;
  private readonly partReleases:(()=>void)[]=[];
  private readonly variant:'line'|'card'|'pill';
  private readonly vertical:boolean;

  constructor(options: GuiTabContainerOptions) {
    if (!options || !Array.isArray(options.pages) || options.pages.length > 10_000) throw new LayoutError('invalid-input', 'Invalid GUI tab pages.');
    const ids = new Set<string>(), contents = new Set<GuiElement>(), encodedIds = new Map<string,string>(), pages: GuiTabPage[] = [];
    for (const original of options.pages) {
      if (!original || typeof original !== 'object') throw new LayoutError('invalid-input', 'Invalid GUI tab page.');
      const page = Object.freeze({...original});
      if (!page || typeof page.id !== 'string' || !page.id || typeof page.title !== 'string' || ids.has(page.id) ||
          !(page.content instanceof GuiElement) || contents.has(page.content) || page.content.parent ||
          (page.hidden !== undefined && typeof page.hidden !== 'boolean') || (page.closable !== undefined && typeof page.closable !== 'boolean'))
        throw new LayoutError('invalid-input', 'Tab pages require unique stable IDs and distinct unattached content.');
      ids.add(page.id); contents.add(page.content);
      headerStyle(page);
      try {encodedIds.set(page.id, encodeURIComponent(page.id));}
      catch {throw new LayoutError('invalid-input', 'Tab page IDs must contain well-formed UTF-16.', page.id);}
      pages.push(page);
    }
    const tabWidth = finiteNonnegative(options.tabWidth ?? 144, 'Tab width'), tabHeight = finiteNonnegative(options.tabHeight ?? 36, 'Tab height');
    const placement=choice(options.placement??'top',['top','bottom','left','right'],'tab placement');this.variant=choice(options.variant??'line',['line','card','pill'],'tab variant');this.vertical=placement==='left'||placement==='right';
    if (tabWidth < 48 || !tabHeight) throw new LayoutError('invalid-input', 'Tab width must be at least 48 and height must be positive.');
    if (options.activeId !== undefined && options.activeId !== null && !pages.some(p => p.id === options.activeId && !p.hidden))
      throw new LayoutError('invalid-input', 'The initial active page must exist and be visible.');
    this.focus = options.focus;
    this.onActiveChange = options.onActiveChange; this.onClose = options.onClose;
    this.element = createGuiContainer(this.vertical?'row':'column', {...(options.id === undefined ? {} : {id: options.id}), style: {width: 'auto', height: 'auto', minWidth: 0, minHeight: 0}});
    if (options.style) this.element.setStyle(options.style);
    this.header = this.element.add(createGuiContainer(this.vertical?'column':'flow', {id: `${this.element.id}:tabs`, style: {width:this.vertical?tabWidth:{percent:100},height:this.vertical?{percent:100}:'auto', shrink: 0, alignItems: 'start', alignContent: 'start'}}));
    this.body = this.element.add(createGuiContainer('grid', {id: `${this.element.id}:body`, style: {width: 'auto', height: 'auto', grow: 1, basis: 0, minWidth: 0, minHeight: 0, columns: [{fr: 1}], rows: [{fr: 1}]}}));
    this.partReleases.push(this.element.bindPart('header',this.header),this.element.bindPart('body',this.body));
    if(placement==='bottom'||placement==='right')this.element.children.splice(0,2,this.body,this.header);
    const acquired: (() => void)[] = [];
    try {
      for (const page of pages) {
        const release = ownContentFrame(page.content); acquired.push(release);
        const header = createGuiContainer('row', {id: `${this.element.id}:tab:${encodedIds.get(page.id)!}`, style: {width: tabWidth, height: tabHeight, shrink: 0}});
        const button = header.add(new GuiButton({id: `${header.id}:select`, text: page.title, style:headerStyle(page), themeControlType: 'GuiTab',
          onClick: () => {if (!this.disposed) this.activate(page.id);},
          onAction: event => {
            const negative=this.vertical?'up':'left',positive=this.vertical?'down':'right';
            if (this.disposed || ![negative,positive].includes(event.action)) return;
            const visible = this.entries.filter(entry => !entry.hidden);
            const index = visible.findIndex(entry => entry.page.id === page.id);
            const next = visible[(index + (event.action === negative ? -1 : 1) + visible.length) % visible.length];
            if (next) {this.activate(next.page.id); this.focus?.focus(next.button); event.consume();}
          }}));
        setContainerStyle(button, {width: 'auto', height: {percent: 100}, grow: 1, basis: 0, minWidth: 0});
        const close = page.closable ? header.add(new GuiButton({id: `${header.id}:close`, text: 'x', themeControlType: 'GuiTabClose',
          onClick: () => {if (!this.disposed) this.close(page.id);}})) : null;
        if (close) setContainerStyle(close, {width: 32, height: {percent: 100}, shrink: 0});
        const indicator=header.add(surface('GuiTabIndicator',{position:'absolute',width:this.vertical?2:{percent:100},height:this.vertical?{percent:100}:2,inset:this.vertical?{right:0,top:0}:{left:0,bottom:0}},{},theme=>({backgroundColor:theme.colors.primary,radius:1})));
        const partReleases=[this.element.bindPart('tab',button),this.element.bindPart('indicator',indicator)];if(close)partReleases.push(this.element.bindPart('close',close));
        const releaseEntry=()=>{const cleanup=new GuiCleanup();for(const off of partReleases.splice(0))cleanup.run(off);cleanup.run(release);cleanup.complete('GUI tab frame cleanup failed.');};
        this.entries.push({page, hidden: !!page.hidden, header, button, close, lastFocus: null, release:releaseEntry,indicator});
      }
      this.rebuildHeaders();
      this.current = options.activeId ?? this.entries.find(entry => !entry.hidden)?.page.id ?? null;
      const active = this.entry(this.current); if (active) this.body.add(active.page.content);
      this.updateHeaders();
    } catch (error) {
      this.disposed = true;
      const entries = this.entries, cleanup = new GuiCleanup();
      this.entries = []; this.current = null; this.onActiveChange = undefined; this.onClose = undefined;
      for (const entry of entries) {
        cleanup.run(() => {entry.page.content.parent?.remove(entry.page.content);});
        cleanup.run(() => {entry.header.parent?.remove(entry.header);});
        cleanup.run(() => entry.button.setDisabled(true));
        cleanup.run(() => entry.close?.setDisabled(true));
      }
      for (const release of acquired.reverse()) cleanup.run(release);
      cleanup.complete('GUI tab construction and rollback failed.', {cause: error});
    }
  }

  get activeId(): string | null {return this.current;}
  get pages(): readonly GuiTabPage[] {return Object.freeze(this.entries.map(entry => Object.freeze({...entry.page, hidden: entry.hidden})));}
  setPageHeader(id:string,options:GuiTabHeaderOptions):void {
    this.assertLive();const entry=this.required(id);
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['title','icon','iconPosition','iconSize','iconGap'].includes(k))||Object.hasOwn(options,'title')&&typeof options.title!=='string')throw new LayoutError('invalid-input','Invalid tab header update.');
    const style=headerStyle(options),next=Object.freeze({...entry.page,...options});
    if(Object.keys(options).every(key=>Object.is(entry.page[key as keyof GuiTabPage],next[key as keyof GuiTabPage])))return;
    entry.page=next;entry.button.setText(next.title);entry.button.setStyle(style);
  }
  activate(id: string): void {
    this.assertLive(); const next = this.entry(id);
    if (!next || next.hidden) throw new LayoutError('invalid-input', 'Cannot activate a missing or hidden tab page.');
    this.select(next);
  }
  /** Application-visible hiding leaves the content and its dirty state alive. */
  setPageVisible(id: string, visible: boolean): void {
    this.assertLive(); const entry = this.required(id);
    if (typeof visible !== 'boolean') throw new LayoutError('invalid-input', 'Page visibility must be boolean.');
    if (entry.hidden === !visible) return;
    entry.hidden = !visible;
    const before = this.current;
    if (entry.hidden && this.current === id) this.select(this.neighbour(this.entries.indexOf(entry)), false);
    else if (!entry.hidden && this.current === null) this.select(entry, false);
    this.rebuildHeaders(); this.element.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
    if (before !== this.current) this.onActiveChange?.(this.current);
  }
  close(id: string): boolean {
    this.assertLive(); const entry = this.required(id);
    if (!entry.page.closable || this.onClose?.(id) === false) return false;
    // A close policy may synchronously remove another page or dispose the control.
    if (this.disposed || !this.entry(id)) return false;
    this.remove(id); return true;
  }
  remove(id: string): void {
    this.assertLive(); const entry = this.required(id), index = this.entries.indexOf(entry);
    const before = this.current;
    if (this.current === id) this.select(this.neighbour(index), false);
    else if (within(this.focus?.focused ?? null, entry.header)) this.focus?.focus(this.entry(this.current)?.button ?? null);
    entry.header.parent?.remove(entry.header);
    entry.page.content.parent?.remove(entry.page.content);
    entry.release(); entry.lastFocus = null;
    this.entries.splice(this.entries.indexOf(entry), 1);
    this.element.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
    if (before !== this.current) this.onActiveChange?.(this.current);
  }
  move(id: string, index: number): void {
    this.assertLive(); const entry = this.required(id);
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.entries.length) throw new LayoutError('invalid-input', 'Invalid tab position.');
    if (this.entries.indexOf(entry) === index) return;
    this.entries.splice(this.entries.indexOf(entry), 1); this.entries.splice(index, 0, entry);
    this.rebuildHeaders();
  }
  serialize(): {readonly version: 1; readonly type: 'gui-tab-container'; readonly order: readonly string[]; readonly hidden: readonly string[]; readonly activeId: string | null} {
    this.assertLive(); return {version: 1, type: 'gui-tab-container', order: this.entries.map(e => e.page.id), hidden: this.entries.filter(e => e.hidden).map(e => e.page.id), activeId: this.current};
  }
  restore(value: unknown): void {
    this.assertLive(); const state = stateRecord(value, 'gui-tab-container', ['version', 'type', 'order', 'hidden', 'activeId']);
    if (!Array.isArray(state.order) || state.order.length !== this.entries.length || new Set(state.order).size !== this.entries.length ||
        state.order.some(id => typeof id !== 'string' || !this.entry(id)) || !Array.isArray(state.hidden) ||
        new Set(state.hidden).size !== state.hidden.length || state.hidden.some(id => typeof id !== 'string' || !this.entry(id)) ||
        (state.activeId !== null && (typeof state.activeId !== 'string' || !this.entry(state.activeId) || state.hidden.includes(state.activeId))) ||
        (state.activeId === null && state.hidden.length !== this.entries.length))
      throw new LayoutError('invalid-input', 'Tab state must match the current page IDs and a visible active page.');
    const entries = state.order.map(id => this.required(id as string));
    this.entries = entries;
    for (const entry of entries) entry.hidden = state.hidden.includes(entry.page.id);
    const before = this.current;
    this.select(this.entry(state.activeId as string | null), false);
    this.rebuildHeaders();
    if (before !== this.current) this.onActiveChange?.(this.current);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const entries = this.entries, cleanup = new GuiCleanup();
    this.entries = []; this.current = null; this.onActiveChange = undefined; this.onClose = undefined;
    cleanup.run(() => {if (within(this.focus?.focused ?? null, this.element)) this.focus?.blur();});
    cleanup.run(() => {this.element.parent?.remove(this.element);});
    for(const off of this.partReleases.splice(0))cleanup.run(off);
    for (const entry of entries) {
      entry.lastFocus = null;
      cleanup.run(() => {entry.page.content.parent?.remove(entry.page.content);});
      cleanup.run(() => {entry.header.parent?.remove(entry.header);});
      cleanup.run(() => entry.button.setDisabled(true));
      cleanup.run(() => entry.close?.setDisabled(true));
      cleanup.run(entry.release);
    }
    cleanup.run(() => this.focus?.reconcile());
    cleanup.complete('GUI tab cleanup failed.');
  }
  private select(next: PageEntry | undefined, notify = true): void {
    const id = next?.page.id ?? null; if (this.current === id) return;
    if (next?.page.content.parent && next.page.content.parent !== this.body)
      throw new LayoutError('invalid-input', 'Tab content was attached to another parent.');
    const previous = this.entry(this.current), focused = this.focus?.focused ?? null;
    const fromContent = !!previous && within(focused, previous.page.content);
    const fromHeader = within(focused, this.header);
    if (previous) {
      if (fromContent) previous.lastFocus = focused;
      previous.page.content.parent?.remove(previous.page.content);
    }
    this.current = id;
    if (next) {this.body.add(next.page.content); next.page.content.markDirty(GuiDirtyFlags.All);}
    this.updateHeaders();
    if (fromContent || fromHeader) {
      const remembered = next?.lastFocus;
      let valid = !!next && !!remembered && remembered.focusOptions.mode !== 'none' && within(remembered, next.page.content);
      for (let node = remembered; valid && node && node !== next?.page.content.parent; node = node.parent) valid = node.visible && !node.disabled && layoutStyleVisible(node);
      const target = fromContent && next ? valid ? remembered! : firstFocusable(next.page.content) ?? next.button : next?.button ?? null;
      this.focus?.reconcile();
      this.focus?.focus(target);
      // The existing focus domain also knows layout-hidden nodes and modal
      // ownership. A public tree walk cannot override those eligibility rules.
      if (this.focus && this.focus.focused !== target) this.focus.focus(next?.button ?? null);
    }
    this.element.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
    if (notify) this.onActiveChange?.(id);
  }
  private updateHeaders(): void {
    for (const entry of this.entries) {
      const selected=entry.page.id===this.current;entry.button.variant=selected?'primary':'default';entry.button.setVisualState({selected});
      entry.button.setDefaultSkin((theme,state)=>({backgroundColor:this.variant==='line'?'transparent':selected?this.variant==='pill'?theme.colors.primary:theme.colors.elevated??theme.colors.surface:state.hover?theme.colors.hover:'transparent',borderWidth:this.variant==='card'?1:0,borderColor:theme.colors.border,radius:this.variant==='pill'?16:this.variant==='card'?6:0,color:selected?this.variant==='pill'?theme.colors.onPrimary??'#fff':theme.colors.primary:theme.colors.textMuted,padding:10,paddingY:4}));
      if(entry.close)entry.close.setDefaultSkin(theme=>({backgroundColor:'transparent',borderWidth:0,padding:2,paddingY:2,color:theme.colors.textMuted}));
      show(entry.indicator,selected&&this.variant==='line');entry.button.markDirty(GuiDirtyFlags.Visual);
    }
  }
  private rebuildHeaders(): void {
    for (const child of [...this.header.children]) this.header.remove(child);
    for (const entry of this.entries) if (!entry.hidden) this.header.add(entry.header);
    this.header.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
  }
  private neighbour(index: number): PageEntry | undefined {return this.entries.slice(index + 1).find(e => !e.hidden) ?? [...this.entries.slice(0, index)].reverse().find(e => !e.hidden);}
  private entry(id: string | null): PageEntry | undefined {return this.entries.find(e => e.page.id === id);}
  private required(id: string): PageEntry {const entry = this.entry(id); if (!entry) throw new LayoutError('invalid-input', 'Unknown tab page.'); return entry;}
  private assertLive(): void {if (this.disposed) throw new LayoutError('disposed', 'GUI tab container has been disposed.');}
}
