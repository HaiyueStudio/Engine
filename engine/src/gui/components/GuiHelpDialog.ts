import { GuiModal, type GuiModalOptions } from './GuiModal';
import { GuiLabel } from './GuiLabel';
import { GuiScrollView } from './GuiScrollView';
import type { GuiRect } from '../GuiTypes';

type Measure = (text: string, fontSize: number) => number;
const textMetrics = new WeakMap<GuiHelpDialog, Measure>();
/** Internal font adapter; no renderer resources are exposed through the component API. */
export function setGuiHelpDialogTextMetrics(dialog: GuiHelpDialog, measure: Measure): void {
  textMetrics.set(dialog, measure);
}
export interface GuiHelpDialogOptions extends Omit<
  GuiModalOptions,
  'showConfirmButton' | 'showCancelButton' | 'showCloseButton' | 'closeOnBackdrop'
> {}

/** Persistent, dismissible help with word wrapping and scrollable long content. */
export class GuiHelpDialog extends GuiModal {
  readonly body: GuiScrollView;
  private textKey = '';
  constructor(options: GuiHelpDialogOptions = {}) {
    super({
      width: 420,
      height: 390,
      ...options,
      showConfirmButton: false,
      showCancelButton: false,
      showCloseButton: true,
      closeOnBackdrop: true,
    });
    this.body = this.add(
      new GuiScrollView({ id: `${this.id}-body`, width: '100%', height: '100%' }),
    );
    this.titleLabel.setFontSize(18);
    this.messageLabel.setFontSize(15);
    this.messageLabel.setVisible(false);
  }
  override show(): void {
    this.body.scrollTo(0);
    super.show();
  }
  override layout(parent: GuiRect): void {
    super.layout(parent);
    this.closeButton.rect = {
      x: this.dialogRect.x + this.dialogRect.width - 52,
      y: this.dialogRect.y + 10,
      width: 44,
      height: 44,
    };
    const rect = {
      x: this.dialogRect.x + 24,
      y: this.dialogRect.y + 66,
      width: this.dialogRect.width - 48,
      height: Math.max(0, this.dialogRect.height - 90),
    };
    this.body.rect = rect;
    const size = this.messageLabel.fontSize ?? 15,
      lineHeight = size * 1.5;
    const measure = textMetrics.get(this) ?? ((text: string, s: number) => text.length * s);
    const key = `${this.message}|${rect.width}|${size}|${textMetrics.has(this)}`;
    if (key !== this.textKey) {
      this.textKey = key;
      for (const child of [...this.body.children]) this.body.remove(child);
      const lines = wrapText(this.message, Math.max(1, rect.width - 10), size, measure);
      lines.forEach((text, i) =>
        this.body.add(
          new GuiLabel({
            text,
            fontSize: size,
            y: i * lineHeight,
            width: '100%',
            height: lineHeight,
          }),
        ),
      );
      this.body.setContentHeight(lines.length * lineHeight);
    }
    for (const child of this.body.children)
      child.setStyle({ color: this.messageLabel.style.color ?? this.style.color ?? '#ffffff' });
    // The viewport is positioned by the dialog; children remain content-relative.
    this.body.layout({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  }
}
function wrapText(text: string, width: number, size: number, measure: Measure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const token of paragraph.match(/[A-Za-z0-9][A-Za-z0-9’'.,:;!?()/-]*|[^A-Za-z0-9]/gu) ??
      []) {
      if (line && measure(line + token, size) > width) {
        lines.push(line.trimEnd());
        line = '';
      }
      if (!line && token === ' ') continue;
      for (const char of token) {
        if (line && measure(line + char, size) > width) {
          lines.push(line);
          line = '';
        }
        line += char;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
