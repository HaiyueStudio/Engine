import { GuiButton, GuiDirtyFlags, GuiElement, GuiLabel, GuiModal, GuiScrollView } from '@haiyue/engine/gui';
import type { GuiRoot, GuiSystem } from '@haiyue/engine/gui';
import { createGuiVirtualList } from '../../gui-collections/List.js';
import type { GuiVirtualList } from '../../gui-collections/types';
import type { ReadingEntry, ReadingPlayback, ReadingPreferences, ReadingView } from './ReadingPlayback';
import { readingOffsets, wrapReadingText } from './reading-text.js';
import type { ReadingLine } from './reading-text';

type Box = { x: number; y: number; width: number; height: number };
export interface ReadingInsets { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
export interface ReadingTheme {
  readonly panel: string;
  readonly text: string;
  readonly accent: string;
  readonly disabled: string;
  readonly button: string;
  readonly border: string;
}
const english = {
  continue: 'Continue', auto: 'Auto', skip: 'Skip read', history: 'History', settings: 'Settings',
  waiting: 'Waiting…', replay: 'Replay voice', noHistory: 'No dialogue yet', speed: 'Text speed',
  font: 'Text size', contrast: 'High contrast', motion: 'Reduced motion', volume: 'Voice volume', on: 'On', off: 'Off', instant: 'Instant',
};
const chinese: typeof english = {
  continue: '继续', auto: '自动', skip: '跳过已读', history: '历史', settings: '设置',
  waiting: '演出中…', replay: '重听配音', noHistory: '暂无对白', speed: '字速', font: '字号', contrast: '高对比度',
  motion: '减少动态效果', volume: '配音音量', on: '开', off: '关', instant: '即时',
};
type Word = keyof typeof english;
export interface GuiReadingOptions {
  readonly root: GuiRoot;
  readonly gui: GuiSystem;
  readonly playback: ReadingPlayback;
  readonly theme?: Partial<ReadingTheme>;
  readonly label?: (key: Word, locale: string) => string;
  readonly measure?: (text: string, size: number) => number;
  readonly document?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
  readonly signal?: AbortSignal;
}
const theme: ReadingTheme = { panel: '#172437f5', text: '#f0f6ff', accent: '#8be3f2', disabled: '#8a9ab2', button: '#263a52', border: '#536980' };
const highContrast: ReadingTheme = { panel: '#000000', text: '#ffffff', accent: '#ffff00', disabled: '#bdbdbd', button: '#151515', border: '#ffffff' };
const zeroInsets = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });
const unbounded = { mode: 'unbounded' } as const;
const TOOLBAR = ['continue', 'auto', 'skip', 'history', 'settings'] as const;
const prefs = ['speed', 'font', 'contrast', 'motion', 'volume'] as const;
const zeroBox = { x: 0, y: 0, width: 0, height: 0 };
const historyHeight = 144;
const historyRowHeight = 44;
const inside = (element: GuiElement, parent: GuiElement): boolean => {
  for (let node: GuiElement | null = element; node; node = node.parent) if (node === parent) return true;
  return false;
};

/** Keep the original control identity and focus while changing its rectangle. */
function positioned<T extends GuiElement>(element: T) {
  const layout = element.layout.bind(element);
  let box: Box = zeroBox;
  element.layout = parent => layout({ x: parent.x + box.x, y: parent.y + box.y, width: box.width, height: box.height });
  return {
    element,
    place(next: Box) {
      if (box.x === next.x && box.y === next.y && box.width === next.width && box.height === next.height) return;
      box = next;
      element.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
    },
  };
}
type PositionedLabel = ReturnType<typeof positioned<GuiLabel>>;
type PositionedButton = ReturnType<typeof positioned<GuiButton>>;
const makeLabel = (id: string) => positioned(new GuiLabel({ id, width: '100%', height: '100%', pointerFilter: 'ignore' }));
const makeButton = (id: string, call: () => void) => positioned(new GuiButton({ id, width: '100%', height: '100%', onClick: call }));
const cycle = (values: readonly number[], current: number) => values.find(value => value > current) ?? values[0]!;

interface LabelLine {
  readonly line: ReadingLine;
  readonly label: PositionedLabel;
}
interface Choice {
  readonly button: PositionedButton;
  lines: PositionedLabel[];
}
interface Menu { readonly modal: GuiModal; readonly body: GuiScrollView }

let nextGui = 0;
/** Visual novel reading controls using only the original GUI presentation and input domain. */
export class GuiReading {
  readonly panel: GuiElement;
  readonly historyMenu: GuiModal;
  readonly settingsMenu: GuiModal;
  readonly historyList: GuiVirtualList<ReadingEntry>;
  readonly controls: Readonly<Record<typeof TOOLBAR[number], GuiButton>>;
  private readonly id = `vn-reader:${++nextGui}`;
  private readonly scroll = new GuiScrollView({ width: '100%', height: '100%', focus: { mode: 'none' } });
  private scrollBox = zeroBox;
  private readonly sample = new GuiLabel({ visible: false, width: 0, height: 0 });
  // The stock atlas discovers these clusters before the first progressively painted line.
  private readonly glyphSource = new GuiLabel({ visible: false, width: 0, height: 0 });
  private readonly speaker = makeLabel(`${this.id}:speaker`);
  private readonly toolbar: Record<typeof TOOLBAR[number], PositionedButton>;
  private readonly settings: Record<typeof prefs[number], PositionedButton>;
  private readonly history: Menu;
  private readonly preferences: Menu;
  private readonly detail = makeLabel(`${this.id}:history-detail`);
  private readonly replay: PositionedButton;
  private readonly choices = new Map<string, Choice>();
  private readonly cleanup: (() => void)[] = [];
  private layoutView: ReadingView | undefined;
  private lastRevision = -1;
  private layoutBounds: Box | undefined;
  private lines: LabelLine[] = [];
  private insets: ReadingInsets = zeroInsets;
  private historyRevision = -1;
  private historyLocale = '';
  private historyFontScale = 0;
  private historyHighContrast = false;
  private selected: ReadingEntry | undefined;
  private latestHistory: ReadingEntry | undefined;
  private byHistoryKey = new Map<string, ReadingEntry>();
  private dead = false;
  private colors = theme;

  constructor(private readonly options: GuiReadingOptions) {
    const { playback, root, gui, signal } = options;
    this.panel = new GuiElement({ id: this.id, pointerFilter: 'pass' });
    this.toolbar = {
      continue: makeButton(`${this.id}:continue`, () => playback.confirm()),
      auto: makeButton(`${this.id}:auto`, () => playback.setMode(playback.view.mode === 'auto' ? 'manual' : 'auto')),
      skip: makeButton(`${this.id}:skip`, () => playback.setMode(playback.view.mode === 'skip' ? 'manual' : 'skip')),
      history: makeButton(`${this.id}:history`, () => this.openHistory()),
      settings: makeButton(`${this.id}:settings`, () => this.openSettings()),
    };
    this.controls = Object.freeze(Object.fromEntries(TOOLBAR.map(key => [key, this.toolbar[key].element])) as typeof this.controls);
    this.settings = Object.fromEntries(prefs.map(key => [key, makeButton(`${this.id}:${key}`, () => this.changePreference(key))])) as typeof this.settings;
    this.replay = makeButton(`${this.id}:replay`, () => { if (this.selected) void playback.replayVoice(this.selected); });
    this.history = this.menu('history');
    this.preferences = this.menu('settings');
    this.historyMenu = this.history.modal;
    this.settingsMenu = this.preferences.modal;
    this.historyList = createGuiVirtualList<ReadingEntry>({
      items: [], keyOf: item => item.key, rowHeight: historyRowHeight, height: historyHeight, overscan: 2, focus: gui.focus,
      onSelection: key => this.selectHistory(key),
      createRow: () => {
        let item: ReadingEntry | undefined;
        const button = new GuiButton({ width: '100%', height: historyRowHeight, onClick: () => {
          if (item) this.historyList.setSelection(item.key);
        } });
        return {
          element: button,
          bind: row => {
            item = row;
            const { speaker, text } = playback.translate(row), first = (speaker ? speaker + ' · ' : '') + text.replace(/\s+/gu, ' ');
            const offsets = readingOffsets(first, playback.view.locale);
            button.setText(offsets.length > 47 ? first.slice(0, offsets[44]) + '…' : first);
            this.buttonStyle(button, Math.min(18, 13 * playback.view.preferences.fontScale));
            return () => { item = undefined; };
          },
          dispose: () => { item = undefined; },
        };
      },
    });
    this.history.body.add(this.historyList.element);
    this.history.body.add(this.detail.element);
    this.history.body.add(this.replay.element);
    for (const key of prefs) this.preferences.body.add(this.settings[key].element);
    this.panel.add(this.scroll);
    this.panel.add(this.glyphSource);
    this.panel.add(this.sample);
    const scrollLayout = this.scroll.layout.bind(this.scroll);
    this.scroll.layout = () => scrollLayout(this.scrollBox);
    this.scroll.add(this.speaker.element);
    for (const key of TOOLBAR) this.panel.add(this.controls[key]);
    this.panel.layout = bounds => this.layout(bounds);
    this.panel.setStyle({ padding: 0, radius: 8 });
    if (signal?.aborted || playback.disposed) { this.dispose(); return; }
    root.add(this.panel); root.add(this.historyMenu); root.add(this.settingsMenu);
    this.cleanup.push(playback.subscribe(() => {
      if (playback.disposed) this.dispose();
      else this.refresh();
    }));
    this.cleanup.push(gui.focus.subscribe(() => playback.setModal(!!gui.focus.modal)));
    const abort = () => this.dispose();
    signal?.addEventListener('abort', abort, { once: true });
    this.cleanup.push(() => signal?.removeEventListener('abort', abort));
    const visible = () => playback.setPageVisible(!options.document?.hidden);
    options.document?.addEventListener('visibilitychange', visible);
    this.cleanup.push(() => options.document?.removeEventListener('visibilitychange', visible));
    if (options.document) visible();
    this.refresh();
  }

  setInsets(value: ReadingInsets): void {
    for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
      if (!Number.isFinite(value[edge]) || value[edge] < 0) throw new RangeError('Invalid reading safe-area inset.');
    }
    this.insets = { ...value };
    this.layoutBounds = undefined;
    this.panel.markDirty(GuiDirtyFlags.Layout);
    this.historyMenu.markDirty(GuiDirtyFlags.Layout);
    this.settingsMenu.markDirty(GuiDirtyFlags.Layout);
  }

  openHistory(): void {
    if (this.dead || this.options.gui.focus.modal) return;
    this.syncHistory();
    this.open(this.history, this.controls.history);
    const last = this.latestHistory;
    if (last) {
      this.historyList.scrollToKey(last.key, 'end');
      this.historyList.setSelection(last.key);
      this.selectHistory(last.key);
    }
  }

  openSettings(): void {
    if (this.dead || this.options.gui.focus.modal) return;
    this.open(this.preferences, this.controls.settings);
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    for (const off of this.cleanup.splice(0)) off();
    this.historyMenu.hide(); this.settingsMenu.hide();
    this.options.playback.setModal(false);
    this.historyList.dispose();
    const root = this.options.root;
    root.remove(this.panel); root.remove(this.historyMenu); root.remove(this.settingsMenu);
    this.options.gui.focus.reconcile();
  }

  private copy(key: Word): string {
    const locale = this.options.playback.view.locale;
    return this.options.label?.(key, locale) ?? (locale.startsWith('zh') ? chinese : english)[key];
  }

  private safe(box: Box): Box {
    const left = Math.min(this.insets.left, Math.max(0, box.width - 1));
    const top = Math.min(this.insets.top, Math.max(0, box.height - 1));
    return { x: box.x + left, y: box.y + top, width: Math.max(1, box.width - left - this.insets.right),
      height: Math.max(1, box.height - top - this.insets.bottom) };
  }

  private menu(name: 'history' | 'settings'): Menu {
    const modal = new GuiModal({
      id: `${this.id}:${name}-modal`, width: 600, height: 480, showConfirmButton: false, showCancelButton: false,
      onClose: () => {
        if (name === 'history') this.options.playback.stopReplay();
        this.options.gui.focus.reconcile();
        this.options.playback.setModal(!!this.options.gui.focus.modal);
      },
    });
    const body = new GuiScrollView({ width: '100%', height: '100%', focus: { mode: 'none' } });
    modal.add(body);
    const stock = modal.layout.bind(modal);
    modal.layout = bounds => {
      stock(this.safe(bounds));
      const dialog = modal.dialogRect, width = Math.max(1, dialog.width - 32), height = Math.max(1, dialog.height - 78);
      if (name === 'history') this.layoutHistory(width);
      else {
        prefs.forEach((key, i) => this.settings[key].place({ x: 0, y: i * 46, width, height: 42 }));
        body.setContentHeight(prefs.length * 46);
      }
      body.layout({ x: dialog.x + 16, y: dialog.y + 62, width, height });
    };
    return { modal, body };
  }

  private open(menu: Menu, opener: GuiButton): void {
    const { gui, playback } = this.options;
    gui.focus.focus(opener);
    menu.modal.show();
    playback.setModal(true);
    gui.focus.reconcile();
  }

  private refresh(): void {
    const view = this.options.playback.view;
    const prior = this.layoutView;
    if (!prior || prior.revision !== view.revision || prior.locale !== view.locale || prior.preferences !== view.preferences ||
      prior.text !== view.text || prior.choices !== view.choices || prior.speaker !== view.speaker) {
      this.layoutView = undefined;
      this.panel.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
      this.colors = view.preferences.highContrast ? highContrast : { ...theme, ...this.options.theme };
      this.glyphSource.setText([view.text, view.speaker, ...view.choices.map(choice => choice.text),
        this.copy('waiting')].join('\n'));
      this.panel.setStyle({ backgroundColor: this.colors.panel, borderColor: this.colors.border });
      this.historyMenu.setTitle(this.copy('history')); this.settingsMenu.setTitle(this.copy('settings'));
      for (const menu of [this.historyMenu, this.settingsMenu]) {
        menu.setStyle({ backgroundColor: this.colors.panel, borderColor: this.colors.border, color: this.colors.text });
        menu.titleLabel.setStyle({ color: this.colors.text });
      }
      for (const key of TOOLBAR) {
        this.controls[key].setText(this.copy(key));
        this.buttonStyle(this.controls[key], Math.min(17, 12 * view.preferences.fontScale));
      }
      this.updateSettings();
      if (this.historyMenu.visible) {
        this.syncHistory();
        this.historyMenu.markDirty(GuiDirtyFlags.Layout);
      }
    }
    this.controls.continue.setDisabled(view.kind !== 'dialogue');
    this.controls.auto.setDisabled(view.kind !== 'dialogue');
    this.controls.skip.setDisabled(!this.options.playback.canSkip);
    this.controls.auto.setStyle({ backgroundColor: view.mode === 'auto' ? this.colors.accent : this.colors.button,
      color: view.mode === 'auto' ? '#000000' : this.colors.text });
    this.controls.skip.setStyle({ backgroundColor: view.mode === 'skip' ? this.colors.accent : this.colors.button,
      color: view.mode === 'skip' ? '#000000' : this.colors.text });
    this.reveal(view);
  }

  private layout(bounds: Box): void {
    if (this.dead) return;
    const view = this.options.playback.view, safe = this.safe(bounds), before = this.layoutBounds;
    if (!this.layoutView || !before || before.x !== safe.x || before.y !== safe.y || before.width !== safe.width || before.height !== safe.height) {
      const { focus } = this.options.gui;
      const previous = focus.focused;
      const previousStoryFocus = previous === this.controls.continue || (previous && inside(previous, this.scroll));
      const changed = this.lastRevision !== view.revision;
      this.lastRevision = view.revision;
      this.layoutView = view;
      this.layoutBounds = safe;
      this.layoutContent(safe, view);
      if (changed) {
        this.scroll.scrollTo(0);
        if (!focus.modal && (!previous || previousStoryFocus)) {
          const first = view.choices.find(item => item.enabled);
          if (first) focus.focus(this.choices.get(first.id)!.button.element);
          else if (view.kind === 'dialogue') focus.focus(this.controls.continue);
        }
      }
    }
    for (const child of this.panel.children) child.layout(this.panel.rect);
  }

  private layoutContent(safe: Box, view: ReadingView): void {
    const margin = Math.min(14, Math.max(6, Math.floor(safe.width * .045)));
    const width = Math.max(1, safe.width - margin * 2), font = 18 * view.preferences.fontScale;
    const toolbarFont = Math.min(17, 12 * view.preferences.fontScale);
    const toolbarWidth = Math.max(...TOOLBAR.map(key => this.measure(this.copy(key), toolbarFont) + 20), 72);
    const columns = Math.min(TOOLBAR.length, Math.max(1, Math.floor((width + 6) / (toolbarWidth + 6))));
    const buttonHeight = Math.max(34, Math.ceil(toolbarFont * 1.6 + 12));
    const toolHeight = Math.ceil(TOOLBAR.length / columns) * (buttonHeight + 6);
    const minimumStory = Math.min(175, Math.floor(safe.height * (view.kind === 'choice' ? .55 : .42)));
    const height = Math.min(safe.height, Math.max(Math.floor(safe.height * .60), toolHeight + minimumStory + margin * 2));
    const storyHeight = Math.max(1, height - toolHeight - margin * 2);
    this.panel.rect = { x: safe.x, y: safe.y + safe.height - height, width: safe.width, height };
    this.scrollBox = { x: this.panel.rect.x + margin, y: this.panel.rect.y + margin, width, height: storyHeight };
    TOOLBAR.forEach((key, index) => {
      const w = (width - (columns - 1) * 6) / columns;
      this.toolbar[key].place({ x: margin + index % columns * (w + 6),
        y: margin + storyHeight + 5 + Math.floor(index / columns) * (buttonHeight + 6), width: w, height: buttonHeight });
    });
    this.buildLines(view, Math.max(1, width - 12), font);
  }

  private buildLines(view: ReadingView, width: number, font: number): void {
    const rowHeight = Math.ceil(this.measureHeight(font));
    const text = view.text || (view.kind === 'action' ? this.copy('waiting') : '');
    const offsets = view.text ? view.offsets : readingOffsets(text, view.locale);
    const rows = wrapReadingText(text, offsets, width, value => this.measure(value, font));
    this.speaker.element.setText(view.speaker);
    this.speaker.element.setFontSize(font * .88);
    this.speaker.element.setStyle({ color: this.colors.accent });
    this.speaker.element.setVisible(!!view.speaker);
    this.speaker.place({ x: 0, y: 0, width, height: rowHeight });
    let y = view.speaker ? rowHeight + 4 : 0;
    while (this.lines.length > rows.length) this.scroll.remove(this.lines.pop()!.label.element);
    rows.forEach((line, i) => {
      const label = this.lines[i]?.label ?? makeLabel(`${this.id}:line:${i}`);
      if (!label.element.parent) this.scroll.add(label.element);
      this.lines[i] = { line, label };
      label.place({ x: 0, y, width, height: rowHeight });
      label.element.setFontSize(font);
      label.element.setStyle({ color: this.colors.text });
      y += rowHeight;
    });
    this.reveal(view);
    const live = new Set(view.choices.map(choice => choice.id));
    for (const [id, choice] of this.choices) if (!live.has(id)) {
      this.scroll.remove(choice.button.element);
      this.choices.delete(id);
    }
    y += 8;
    for (const choice of view.choices) {
      let item = this.choices.get(choice.id);
      if (!item) {
        const button = makeButton(`${this.id}:choice:${choice.id}`, () => this.options.playback.choose(choice.id));
        this.scroll.add(button.element);
        this.choices.set(choice.id, item = { button, lines: [] });
      }
      this.buildChoice(item, choice.text, choice.enabled, view.locale, width, y, font);
      y += item.lines.length * rowHeight + 20;
    }
    this.scroll.setContentHeight(y + 8);
    const { focus } = this.options.gui;
    if (focus.focused && !focus.modal && inside(focus.focused, this.panel)) focus.reconcile();
  }

  private buildChoice(choice: Choice, text: string, enabled: boolean, locale: string, width: number, y: number, font: number): void {
    const rowHeight = Math.ceil(this.measureHeight(font));
    const rows = wrapReadingText(text, readingOffsets(text, locale), Math.max(1, width - 24), value => this.measure(value, font));
    choice.button.place({ x: 0, y, width, height: rows.length * rowHeight + 12 });
    choice.button.element.setDisabled(!enabled);
    this.buttonStyle(choice.button.element, font);
    while (choice.lines.length > rows.length) choice.button.element.remove(choice.lines.pop()!.element);
    rows.forEach(({ text }, index) => {
      let label = choice.lines[index];
      if (!label) {
        label = makeLabel(`${choice.button.element.id}:label:${index}`);
        choice.lines.push(label);
        choice.button.element.add(label.element);
      }
      label.element.setText(text);
      label.element.setFontSize(font);
      label.element.setStyle({ color: enabled ? this.colors.text : this.colors.disabled });
      label.place({ x: 12, y: 6 + index * rowHeight, width: Math.max(1, width - 24), height: rowHeight });
    });
  }

  private reveal(view: ReadingView): void {
    if (!this.layoutView || this.layoutView.offsets !== view.offsets) return;
    for (const { line, label } of this.lines) {
      const end = Math.max(line.start, Math.min(line.end, view.visible));
      label.element.setText(view.kind === 'dialogue' ? view.text.slice(view.offsets[line.start], view.offsets[end]) : line.text);
    }
  }

  private measure(text: string, size: number): number {
    if (this.options.measure) return this.options.measure(text, size);
    this.sample.text = text;
    this.sample.fontSize = size;
    return this.options.root.measureElement(this.sample, unbounded, unbounded).width;
  }

  private measureHeight(size: number): number {
    if (this.options.measure) return size * 1.38;
    this.sample.text = 'Mg';
    this.sample.fontSize = size;
    return Math.max(size, this.options.root.measureElement(this.sample, unbounded, unbounded).height);
  }

  private buttonStyle(button: GuiButton, size: number): void {
    button.setStyle({ fontSize: size, color: this.colors.text, backgroundColor: this.colors.button, borderColor: this.colors.border });
  }

  private changePreference(key: typeof prefs[number]): void {
    const playback = this.options.playback, value = playback.view.preferences;
    const next: Record<typeof prefs[number], Partial<ReadingPreferences>> = {
      speed: { textSpeed: cycle([0, 14, 28, 48, 80, 120], value.textSpeed) },
      font: { fontScale: cycle([.75, 1, 1.25, 1.5, 1.75, 2], value.fontScale) },
      contrast: { highContrast: !value.highContrast },
      motion: { reducedMotion: !value.reducedMotion },
      volume: { voiceVolume: cycle([0, .25, .5, .75, 1], value.voiceVolume) },
    };
    playback.setPreferences(next[key]);
  }

  private updateSettings(): void {
    const value = this.options.playback.view.preferences, percent = (part: number) => `${Math.round(part * 100)}%`;
    const values: Record<typeof prefs[number], string> = {
      speed: value.textSpeed ? String(value.textSpeed) : this.copy('instant'),
      font: percent(value.fontScale), contrast: this.copy(value.highContrast ? 'on' : 'off'),
      motion: this.copy(value.reducedMotion ? 'on' : 'off'), volume: percent(value.voiceVolume),
    };
    for (const key of prefs) {
      const button = this.settings[key].element;
      button.setText(`${this.copy(key)} · ${values[key]}`);
      this.buttonStyle(button, Math.min(21, 14 * value.fontScale));
    }
  }

  private syncHistory(): void {
    const playback = this.options.playback;
    const { locale, preferences: { fontScale, highContrast } } = playback.view;
    const restyle = this.historyLocale !== locale || this.historyFontScale !== fontScale || this.historyHighContrast !== highContrast;
    if (this.historyRevision !== playback.historyRevision || restyle) {
      const items = playback.history().map(item => restyle ? { ...item } : this.byHistoryKey.get(item.key) ?? item);
      this.byHistoryKey = new Map(items.map(item => [item.key, item]));
      this.latestHistory = items.at(-1);
      this.historyList.setItems(items);
      this.historyRevision = playback.historyRevision;
      this.historyLocale = locale;
      this.historyFontScale = fontScale;
      this.historyHighContrast = highContrast;
    }
    this.selectHistory(this.historyList.selectedKey);
  }

  private selectHistory(key: string | null): void {
    this.selected = key === null ? undefined : this.byHistoryKey.get(key);
    const replay = this.replay.element;
    replay.setDisabled(!this.selected || !this.options.playback.voiceAvailable(this.selected));
    this.historyMenu.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
  }

  private layoutHistory(width: number): void {
    const size = Math.min(25, 15 * this.options.playback.view.preferences.fontScale);
    const row = this.selected && this.options.playback.translate(this.selected);
    const text = row ? (row.speaker ? row.speaker + '\n' : '') + row.text : this.copy('noHistory');
    this.detail.element.setText(text);
    this.detail.element.setFontSize(size);
    this.detail.element.setStyle({ color: this.colors.text });
    const lines = wrapReadingText(text, readingOffsets(text, this.options.playback.view.locale), width, part => this.measure(part, size));
    const detailHeight = Math.ceil(this.measureHeight(size)) * Math.max(1, lines.length) + 10;
    this.detail.place({ x: 0, y: historyHeight + 8, width, height: detailHeight });
    this.replay.element.setText(this.copy('replay'));
    this.buttonStyle(this.replay.element, 14);
    this.replay.place({ x: 0, y: historyHeight + 14 + detailHeight, width, height: 38 });
    this.history.body.setContentHeight(historyHeight + 58 + detailHeight);
  }
}
