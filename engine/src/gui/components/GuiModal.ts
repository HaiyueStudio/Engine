import {
  GuiDirtyFlags,
  type GuiElementOptions,
  type GuiLength,
  type GuiPointerEvent,
  type GuiRect,
  resolveGuiLength,
} from '../GuiTypes';
import { GuiButton } from './GuiButton';
import { GuiElement } from './GuiElement';
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
      width: '100%',
      height: '100%',
      visible: options.visible ?? false,
      disabled: options.disabled,
      style: {
        backgroundColor: '#f8fafc',
        borderColor: '#cbd5e1',
        color: '#1f2937',
        radius: 10,
        ...options.style,
      },
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
    this.backdropColor = options.backdropColor ?? 'rgba(15,23,42,0.48)';
    this.onConfirm = options.onConfirm ?? null;
    this.onCancel = options.onCancel ?? null;
    this.onClose = options.onClose ?? null;

    this.titleLabel = this.add(new GuiLabel({
      text: this.title,
      fontSize: 26,
      style: { color: this.style.color ?? '#1f2937' },
    }));
    this.messageLabel = this.add(new GuiLabel({
      text: this.message,
      fontSize: 17,
      style: { color: this.style.color ?? '#475569' },
    }));
    this.closeButton = this.add(new GuiButton({
      text: 'X',
      style: {
        backgroundColor: 'transparent',
        hoverBackgroundColor: 'rgba(15,23,42,0.10)',
        color: this.style.color ?? '#475569',
        hoverColor: this.style.color ?? '#0f172a',
        borderColor: 'transparent',
        radius: 6,
      },
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

  override layout(parentRect: GuiRect): void {
    this.rect = { ...parentRect };
    const availableWidth = Math.max(1, parentRect.width - 32);
    const availableHeight = Math.max(1, parentRect.height - 32);
    const width = Math.min(availableWidth, resolveGuiLength(this.dialogWidth, parentRect.width, 420));
    const height = Math.min(availableHeight, resolveGuiLength(this.dialogHeight, parentRect.height, 230));
    this.dialogRect.x = parentRect.x + (parentRect.width - width) * 0.5;
    this.dialogRect.y = parentRect.y + (parentRect.height - height) * 0.5;
    this.dialogRect.width = width;
    this.dialogRect.height = height;

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
    if (this.closeOnBackdrop && event.target === this) this.close('backdrop');
  }

  private syncButtonVisibility(): void {
    this.closeButton.setVisible(this.showCloseButton);
    this.confirmButton.setVisible(this.showConfirmButton);
    this.cancelButton.setVisible(this.showCancelButton);
  }
}
