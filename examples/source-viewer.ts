import { javascript } from '@codemirror/lang-javascript';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, highlightSpecialChars, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';

export interface SourceViewer {
  setSource(source: string): void;
  destroy(): void;
}

const haiyueTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: '#0b1018',
    color: '#d8e2f2',
    fontSize: '12px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  },
  '.cm-content': {
    minWidth: 'max-content',
    padding: '12px 0 28px',
    caretColor: 'transparent',
  },
  '.cm-line': { padding: '0 18px 0 8px' },
  '.cm-line, .cm-gutterElement': { lineHeight: '1.6' },
  '.cm-gutters': {
    paddingTop: '12px',
    border: 'none',
    backgroundColor: '#0b1018',
    color: '#53647c',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '38px',
    padding: '0 8px 0 10px',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: '#264f78 !important',
  },
  '.cm-cursor': { display: 'none' },
}, { dark: true });

const haiyueHighlight = HighlightStyle.define([
  { tag: tags.comment, color: '#6a9955', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: '#c586c0' },
  { tag: [tags.controlKeyword, tags.moduleKeyword], color: '#c586c0' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#4ec9b0' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#dcdcaa' },
  { tag: [tags.definition(tags.variableName), tags.variableName], color: '#9cdcfe' },
  { tag: tags.propertyName, color: '#9cdcfe' },
  { tag: [tags.string, tags.special(tags.string)], color: '#ce9178' },
  { tag: [tags.number, tags.bool, tags.null], color: '#b5cea8' },
  { tag: [tags.regexp, tags.escape], color: '#d16969' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: '#d4d4d4' },
  { tag: [tags.meta, tags.annotation], color: '#c8c8c8' },
  { tag: tags.invalid, color: '#f44747', textDecoration: 'underline' },
]);

export function createSourceViewer(parent: HTMLElement): SourceViewer {
  const root = parent.shadowRoot ?? parent.attachShadow({ mode: 'open' });
  root.replaceChildren();
  const view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: '',
      extensions: [
        EditorState.readOnly.of(true),
        lineNumbers(),
        highlightSpecialChars(),
        javascript({ typescript: true, jsx: true }),
        syntaxHighlighting(haiyueHighlight),
        haiyueTheme,
      ],
    }),
  });

  return {
    setSource(source: string): void {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: source },
      });
      view.scrollDOM.scrollTo(0, 0);
    },
    destroy(): void {
      view.destroy();
    },
  };
}
