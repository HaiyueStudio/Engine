import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {admitGuiControl} from '../GuiControlIdentity';
import {
  GuiDirtyFlags,
  type GuiElementOptions,
  type GuiLength,
  type GuiPointerEvent,
  type GuiRect,
  resolveGuiLength,
  containsPoint,
} from '../GuiTypes';
import { GuiButton } from './GuiButton';
import { GuiElement } from './GuiElement';
import {assignedGuiRect} from '../GuiLayoutState';
import { GuiLabel } from './GuiLabel';

export type GuiModalCloseReason = 'close' | 'confirm' | 'cancel' | 'backdrop';
export type GuiModalHandler = (modal: GuiModal) => void;
export type GuiModalCloseHandler = (reason: GuiModalCloseReason, modal: GuiModal) => void;

export interface GuiModalOptions extends Omit<GuiElementOptions, 'x' | 'y'> {
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  showCloseButton?: boolean;
  showConfirmButton?: boolean;
  showCancelButton?: boolean;
  closeOnBackdrop?: boolean;
  backdropColor?: string;
  onConfirm?: GuiModalHandler;
  onCancel?: GuiModalHandler;
  onClose?: GuiModalCloseHandler;
}

export class GuiModal extends GuiElement {
  private static readonly __controlIdentityGuiModal = /* @__PURE__ */ (() => admitGuiControl(GuiModal.prototype, 'GuiModal', undefined, paintGuiModal, (_modal,theme)=>({radius:12,backgroundColor:theme.colors.elevated??theme.colors.surface,borderColor:theme.colors.border,shadow:{color:theme.colors.shadow??theme.colors.overlay??'#0006',blur:18,y:8},parts:{title:{fontSize:20,fontWeight:600},body:{fontSize:14,color:theme.colors.textMuted},close:{color:theme.colors.textMuted,padding:4,paddingY:4,fontSize:18},footer:{}}})))();
  static override readonly themeControlType: string = 'GuiModal';
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  showCloseButton: boolean;
  showConfirmButton: boolean;
  showCancelButton: boolean;
  closeOnBackdrop: boolean;
  backdropColor: string;
  readonly dialogRect: GuiRect = { x: 0, y: 0, width: 0, height: 0 };
  readonly titleLabel: GuiLabel;
  readonly messageLabel: GuiLabel;
  readonly closeButton: GuiButton;
  readonly confirmButton: GuiButton;
  readonly cancelButton: GuiButton;

  private readonly dialogWidth: GuiLength;
  private readonly dialogHeight: GuiLength;
  private onConfirm: GuiModalHandler | null;
  private onCancel: GuiModalHandler | null;
  private onClose: GuiModalCloseHandler | null;

  constructor(options: GuiModalOptions = {}) {
    super({
      id: options.id,
      ...(options.focus ? {focus: options.focus} : {}),
      ...(options.pointerFilter ? {pointerFilter: options.pointerFilter} : {}),
      ...(options.onAction ? {onAction: options.onAction} : {}),
      width: '100%',
      height: '100%',
      visible: options.visible ?? false,
      disabled: options.disabled,
      themeResource:options.themeResource??null,
      style:options.style,
    });
    this.dialogWidth = options.width ?? 420;
    this.dialogHeight = options.height ?? 230;
    this.title = options.title ?? '';
    this.message = options.message ?? '';
    this.confirmText = options.confirmText ?? 'Confirm';
    this.cancelText = options.cancelText ?? 'Cancel';
    this.showCloseButton = options.showCloseButton ?? true;
    this.showConfirmButton = options.showConfirmButton ?? true;
    this.showCancelButton = options.showCancelButton ?? true;
    this.closeOnBackdrop = options.closeOnBackdrop ?? false;
    this.backdropColor = options.backdropColor ?? '';
    this.onConfirm = options.onConfirm ?? null;
    this.onCancel = options.onCancel ?? null;
    this.onClose = options.onClose ?? null;

    this.titleLabel = this.add(new GuiLabel({
      text: this.title,
    }));
    this.messageLabel = this.add(new GuiLabel({
      text: this.message,
    }));
    this.closeButton = this.add(new GuiButton({
      text: '×',variant:'text',
      onClick: () => this.close('close'),
    }));
    this.confirmButton = this.add(new GuiButton({
      text: this.confirmText,
      variant: 'primary',
      onClick: () => this.close('confirm'),
    }));
    this.cancelButton = this.add(new GuiButton({
      text: this.cancelText,
      onClick: () => this.close('cancel'),
    }));
    this.bindPart('title',this.titleLabel);this.bindPart('body',this.messageLabel);this.bindPart('close',this.closeButton);this.bindPart('confirm',this.confirmButton);this.bindPart('cancel',this.cancelButton);
    this.syncButtonVisibility();
  }

  override getLayoutOptions(): Pick<GuiElementOptions, 'x' | 'y' | 'width' | 'height'> {
    return { x: 0, y: 0, width: this.dialogWidth, height: this.dialogHeight };
  }

  show(): void {
    this.setVisible(true);
  }

  hide(): void {
    this.setVisible(false);
  }

  close(reason: GuiModalCloseReason = 'close'): void {
    if (!this.visible) return;
    this.hide();
    if (reason === 'confirm') this.onConfirm?.(this);
    else if (reason === 'cancel') this.onCancel?.(this);
    this.onClose?.(reason, this);
  }

  setTitle(title: string): void {
    if (this.title === title) return;
    this.title = title;
    this.titleLabel.setText(title);
  }

  setMessage(message: string): void {
    if (this.message === message) return;
    this.message = message;
    this.messageLabel.setText(message);
  }

  setConfirmText(text: string): void {
    if (this.confirmText === text) return;
    this.confirmText = text;
    this.confirmButton.setText(text);
  }

  setCancelText(text: string): void {
    if (this.cancelText === text) return;
    this.cancelText = text;
    this.cancelButton.setText(text);
  }

  setShowCloseButton(show: boolean): void {
    if (this.showCloseButton === show) return;
    this.showCloseButton = show;
    this.closeButton.setVisible(show);
  }

  setShowConfirmButton(show: boolean): void {
    if (this.showConfirmButton === show) return;
    this.showConfirmButton = show;
    this.confirmButton.setVisible(show);
    this.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
  }

  setShowCancelButton(show: boolean): void {
    if (this.showCancelButton === show) return;
    this.showCancelButton = show;
    this.cancelButton.setVisible(show);
    this.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
  }

  setHandlers(options: {
    onConfirm?: GuiModalHandler | null;
    onCancel?: GuiModalHandler | null;
    onClose?: GuiModalCloseHandler | null;
  }): void {
    if (options.onConfirm !== undefined) this.onConfirm = options.onConfirm;
    if (options.onCancel !== undefined) this.onCancel = options.onCancel;
    if (options.onClose !== undefined) this.onClose = options.onClose;
  }

  /** Pure geometry used by the original layout delegate before committing any rectangles. */
  getDialogRect(parentRect:GuiRect,_rectFor?:(element:GuiElement)=>GuiRect):GuiRect {
    const width=Math.min(Math.max(1,parentRect.width-32),resolveGuiLength(this.dialogWidth,parentRect.width,420));
    const height=Math.min(Math.max(1,parentRect.height-32),resolveGuiLength(this.dialogHeight,parentRect.height,230));
    return {x:parentRect.x+(parentRect.width-width)/2,y:parentRect.y+(parentRect.height-height)/2,width,height};
  }
  getContentLayoutRect(_child:GuiElement,viewport:GuiRect,rectFor?:(element:GuiElement)=>GuiRect):GuiRect {return this.getDialogRect(viewport,rectFor);}

  override layout(parentRect: GuiRect): void {
    parentRect = assignedGuiRect(this) ?? parentRect;
    this.rect = { ...parentRect };
    Object.assign(this.dialogRect,this.getDialogRect(parentRect));

    const left = this.dialogRect.x + 24;
    const right = this.dialogRect.x + this.dialogRect.width - 24;
    this.titleLabel.rect = {
      x: left,
      y: this.dialogRect.y + 20,
      width: Math.max(0, this.dialogRect.width - (this.showCloseButton ? 88 : 48)),
      height: 34,
    };
    this.closeButton.rect = {
      x: this.dialogRect.x + this.dialogRect.width - 44,
      y: this.dialogRect.y + 14,
      width: 30,
      height: 30,
    };

    const hasActions = this.showConfirmButton || this.showCancelButton;
    const actionsTop = this.dialogRect.y + this.dialogRect.height - (hasActions ? 62 : 20);
    this.messageLabel.rect = {
      x: left,
      y: this.dialogRect.y + 70,
      width: Math.max(0, this.dialogRect.width - 48),
      height: Math.max(24, actionsTop - (this.dialogRect.y + 82)),
    };

    let buttonRight = right;
    if (this.showConfirmButton) {
      this.confirmButton.rect = { x: buttonRight - 112, y: actionsTop, width: 112, height: 40 };
      buttonRight -= 124;
    }
    if (this.showCancelButton) {
      this.cancelButton.rect = { x: buttonRight - 112, y: actionsTop, width: 112, height: 40 };
    }
  }

  override handleClick(event: GuiPointerEvent): void {
    super.handleClick(event);
    if (this.closeOnBackdrop && event.target === this && !containsPoint(this.dialogRect, event.x, event.y)) this.close('backdrop');
  }

  private syncButtonVisibility(): void {
    this.closeButton.setVisible(this.showCloseButton);
    this.confirmButton.setVisible(this.showConfirmButton);
    this.cancelButton.setVisible(this.showCancelButton);
  }
}

/** Original built-in painter; retained with this control, not every GUI owner. */
function paintGuiModal(context:GuiPaint.GuiControlPaintContext, modal: GuiModal, theme: GuiPaint.GuiTheme): void {
    if(theme.density){const skin=context.styleFor(modal);GuiPaint.paintGuiBox(context.currentBatch,modal.dialogRect,skin,GuiPaint.withAlpha(GuiPaint.colorToRgba(skin.backgroundColor,theme.colors.elevated??theme.colors.surface),skin.opacity??1),GuiPaint.withAlpha(GuiPaint.colorToRgba(skin.borderColor,theme.colors.border),skin.opacity??1),context.currentClip,12,skin.opacity??1);return;}
    const opacity = context.styleFor(modal).opacity ?? 1;
    const rect = modal.dialogRect;
    const radius = context.styleFor(modal).radius ?? theme.radius;
    const border = GuiPaint.colorToRgba(context.styleFor(modal).borderColor, theme.colors.border);
    const background = GuiPaint.colorToRgba(context.styleFor(modal).backgroundColor, theme.colors.surface);
    context.addRect(rect.x, rect.y, rect.width, rect.height, radius, GuiPaint.withAlpha(border, opacity));
    context.addRect(
      rect.x + 1,
      rect.y + 1,
      Math.max(0, rect.width - 2),
      Math.max(0, rect.height - 2),
      Math.max(0, radius - 1),
      GuiPaint.withAlpha(background, opacity),
    );
  }
