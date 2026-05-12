// editor.js — CodeMirror 6 editor for DOT source. Two-way binding handled by
// the orchestrator: external `setText` updates the doc without re-firing
// change events that would loop; the `onChange` callback is debounced.

import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

const baseTheme = EditorView.theme(
  {
    '&': {
      color: 'rgba(255,255,255,0.92)',
      backgroundColor: '#1a1a1a',
      height: '100%',
    },
    '.cm-content': {
      caretColor: '#fff',
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    },
    '.cm-gutters': {
      backgroundColor: '#1a1a1a',
      color: '#666',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: '#22232a' },
    '.cm-activeLineGutter': { backgroundColor: '#22232a' },
    '&.cm-focused .cm-cursor': { borderLeftColor: '#fff' },
    '&.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: '#3b4870',
    },
  },
  { dark: true }
);

export function createEditor(host, { initial, onChange }) {
  let suppress = false;
  let timeout = null;

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: initial,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        baseTheme,
        EditorView.editable.of(true),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          if (suppress) return;
          // Debounce so re-renders during fast typing don't thrash.
          clearTimeout(timeout);
          const text = view.state.doc.toString();
          timeout = setTimeout(() => onChange && onChange(text), 250);
        }),
      ],
    }),
  });

  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(text) {
      if (text === view.state.doc.toString()) return;
      suppress = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
      suppress = false;
    },
    destroy() {
      clearTimeout(timeout);
      view.destroy();
    },
  };
}
