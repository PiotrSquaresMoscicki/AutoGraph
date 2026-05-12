// main.js — Application entry point. Wires together state, renderer, editor
// and UI controls. The DOT string is the single source of truth.

import './style.css';
import { emptyDot, focusDot, parseDot, serializeDot } from './dot.js';
import { History } from './state.js';
import { createGraph } from './graph.js';
import { createEditor } from './editor.js';
import { saveDotFile, loadDotFile } from './io.js';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $graph = document.getElementById('graph');
const $editorPane = document.getElementById('editor-pane');
const $editorHost = document.getElementById('editor');
const $labelEdit = document.getElementById('label-edit');
const $btnUndo = document.getElementById('btn-undo');
const $btnRedo = document.getElementById('btn-redo');
const $btnFocus = document.getElementById('btn-focus');
const $btnFit = document.getElementById('btn-fit');
const $btnSave = document.getElementById('btn-save');
const $btnLoad = document.getElementById('btn-load');
const $btnToggleEditor = document.getElementById('btn-toggle-editor');
const $fileInput = document.getElementById('file-input');
const $status = document.getElementById('status');
const $hint = document.getElementById('hint');

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

const history = new History(emptyDot());

// Focus-mode state: when `mainDotSnapshot` is non-null, we're in focus mode
// displaying a derived DOT; the original main DOT is preserved here.
let focusMode = false;
let mainDotSnapshot = null;

let statusTimer = null;
function showStatus(msg, isError = false) {
  $status.textContent = msg;
  $status.classList.toggle('error', !!isError);
  $status.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => $status.classList.remove('show'), 2500);
}

function hideHintSoon() {
  setTimeout(() => $hint.classList.add('hidden'), 6000);
}
hideHintSoon();

// ---------------------------------------------------------------------------
// Renderer / editor wiring
// ---------------------------------------------------------------------------

const graph = createGraph($graph, {
  getDot: () => history.current,
  commit: (newDot) => {
    if (focusMode) {
      // Translate the mutation back into the main DOT by rebuilding focus.
      // Simplest approach: exit focus mode, apply mutation to main DOT.
      const sel = graph.getSelected();
      mainDotSnapshot = applyMutationToMain(newDot);
      focusMode = false;
      $btnFocus.setAttribute('aria-pressed', 'false');
      history.push(mainDotSnapshot);
      mainDotSnapshot = null;
      editor.setText(history.current);
      render();
      if (sel) graph.setSelected(sel);
      return;
    }
    history.push(newDot);
    editor.setText(newDot);
    render();
  },
  onSelect: (id) => {
    // Focus button is enabled only when a node is selected.
    $btnFocus.disabled = !id;
  },
  showStatus,
  editorOverlay: $labelEdit,
});

const editor = createEditor($editorHost, {
  initial: history.current,
  onChange: (text) => {
    if (focusMode) {
      // Editor edits in focus mode only update the focused view. The original
      // main DOT (mainDotSnapshot) is preserved untouched until the user
      // explicitly exits focus mode or commits a UI mutation that propagates.
      history.replaceTop(text);
      render();
      return;
    }
    history.replaceTop(text);
    render();
  },
});

function applyMutationToMain(focusedDot) {
  // We don't try to surgically merge: the focus subgraph contains all kept
  // nodes/edges in canonical form. We diff against mainDotSnapshot's parse
  // and apply additions / label changes / new edges.
  const main = parseDot(mainDotSnapshot);
  const next = parseDot(focusedDot);
  // Merge nodes (add new, update changed labels/attrs).
  for (const [id, n] of next.nodes) {
    if (!main.nodes.has(id)) main.nodes.set(id, { attrs: { ...n.attrs } });
    else Object.assign(main.nodes.get(id).attrs, n.attrs);
  }
  // Merge edges: add any edge whose pair isn't already present.
  for (const e of next.edges) {
    const present = main.edges.some(
      (x) => x.source === e.source && x.target === e.target
    );
    if (!present) main.edges.push({ ...e, attrs: { ...e.attrs } });
    else {
      const existing = main.edges.find(
        (x) => x.source === e.source && x.target === e.target
      );
      Object.assign(existing.attrs, e.attrs);
    }
  }
  // Preserve original graph/default attrs.
  return serializeDot(main);
}

function render() {
  graph.render(history.current);
  updateButtons();
}

function updateButtons() {
  $btnUndo.disabled = !history.canUndo();
  $btnRedo.disabled = !history.canRedo();
  $btnFocus.disabled = !graph.getSelected();
}

history.subscribe(updateButtons);
updateButtons();

// ---------------------------------------------------------------------------
// Toolbar controls
// ---------------------------------------------------------------------------

$btnUndo.addEventListener('click', () => {
  const dot = history.undo();
  if (dot !== null) {
    editor.setText(dot);
    render();
  }
});

$btnRedo.addEventListener('click', () => {
  const dot = history.redo();
  if (dot !== null) {
    editor.setText(dot);
    render();
  }
});

$btnFocus.addEventListener('click', () => {
  if (focusMode) {
    // Exit focus mode: restore main DOT.
    focusMode = false;
    $btnFocus.setAttribute('aria-pressed', 'false');
    history.replaceTop(mainDotSnapshot);
    mainDotSnapshot = null;
    editor.setText(history.current);
    render();
    showStatus('Focus mode off');
  } else {
    const sel = graph.getSelected();
    if (!sel) {
      showStatus('Select a node first', true);
      return;
    }
    mainDotSnapshot = history.current;
    const focused = focusDot(mainDotSnapshot, sel);
    focusMode = true;
    $btnFocus.setAttribute('aria-pressed', 'true');
    // Replace current history entry with the focused view (not a new step).
    history.replaceTop(focused);
    editor.setText(focused);
    render();
    showStatus(`Focusing on “${sel}”`);
  }
});

$btnFit.addEventListener('click', () => {
  // Re-render which auto-fits the view.
  render();
});

$btnSave.addEventListener('click', () => {
  saveDotFile(history.current, 'graph.dot');
  showStatus('Saved graph.dot');
});

$btnLoad.addEventListener('click', () => $fileInput.click());
$fileInput.addEventListener('change', async () => {
  try {
    const text = await loadDotFile($fileInput);
    // Exiting focus mode (loaded content fully replaces the model).
    focusMode = false;
    mainDotSnapshot = null;
    $btnFocus.setAttribute('aria-pressed', 'false');
    history.push(text);
    editor.setText(text);
    render();
    showStatus('Loaded file');
  } catch (err) {
    showStatus('Failed to load file: ' + err.message, true);
  } finally {
    $fileInput.value = '';
  }
});

$btnToggleEditor.addEventListener('click', () => {
  const hidden = $editorPane.hasAttribute('hidden');
  if (hidden) {
    $editorPane.removeAttribute('hidden');
    $btnToggleEditor.setAttribute('aria-pressed', 'true');
  } else {
    $editorPane.setAttribute('hidden', '');
    $btnToggleEditor.setAttribute('aria-pressed', 'false');
  }
  // Defer to next frame so layout settles before re-render fits.
  requestAnimationFrame(() => render());
});

// Keyboard shortcuts (outside the editor pane).
window.addEventListener('keydown', (e) => {
  const insideEditor = e.target && e.target.closest && e.target.closest('.cm-editor');
  const insideInput =
    e.target &&
    (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
  if (insideEditor || insideInput) return;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    $btnUndo.click();
  } else if (
    ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') ||
    ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')
  ) {
    e.preventDefault();
    $btnRedo.click();
  }
});

// Re-render on window resize so the SVG re-fits the host.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 150);
});

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

render();
