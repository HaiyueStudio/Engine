import type {GuiElement, GuiElementOptions, GuiFocusManager} from '@haiyue/engine/gui';

export interface GuiSplitPanelOptions {
  readonly axis: 'horizontal' | 'vertical';
  readonly ratio: number;
  readonly first: GuiElement;
  readonly second: GuiElement;
  readonly id?: string;
  readonly minimumFirst?: number;
  readonly minimumSecond?: number;
  /** Logical pixels, independent of the host device pixel ratio. */
  readonly dividerSize?: number;
  readonly keyboardStep?: number;
  readonly style?: GuiElementOptions['style'];
  readonly onRatioChange?: (ratio: number) => void;
}

export interface GuiTabPage {
  readonly id: string;
  readonly title: string;
  readonly content: GuiElement;
  readonly closable?: boolean;
  readonly hidden?: boolean;
}

export interface GuiTabContainerOptions {
  readonly pages: readonly GuiTabPage[];
  readonly activeId?: string | null;
  readonly id?: string;
  /** Pass the GUI system's existing focus domain; this control never creates a second one. */
  readonly focus?: GuiFocusManager;
  readonly tabWidth?: number;
  readonly tabHeight?: number;
  readonly style?: GuiElementOptions['style'];
  readonly onActiveChange?: (id: string | null) => void;
  /** Return false to veto a user close request. Programmatic remove is unconditional. */
  readonly onClose?: (id: string) => boolean | void;
}
