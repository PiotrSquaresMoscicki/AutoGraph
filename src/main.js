import './style.css';
import { instance as vizInstance } from '@viz-js/viz';
import { serialize, parse } from './dot.js';

// ---------- Layout ----------
document.querySelector('#app').innerHTML = `
  <header>
    <h1>AutoGraph</h1>
    <span class="header-actions">
      <button id="btn-save" type="button">Save</button>
      <button id="btn-load" type="button">Load</button>
      <button id="btn-toggle-dot" type="button">Show DOT</button>
      <input id="file-input" type="file" accept=".dot,.gv,text/vnd.graphviz,text/plain" hidden />
    </span>
  </header>
  <main>
    <div id="graph-pane">
      <div id="graph"></div>
      <svg id="drag-line"><line x1="0" y1="0" x2="0" y2="0" stroke="#3182ce" stroke-width="2" stroke-dasharray="5,4"/></svg>
    </div>
    <div id="dot-pane">
      <label for="dot">DOT source (single source of truth)</label>
      <textarea id="dot" spellcheck="false"></textarea>
      <div id="status"></div>
    </div>
  </main>
`;

// ---------- State ----------
const state = {
  name: 'graph',
  nodes: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
  edges: [
    { from: 'a', to: 'b', label: '' },
  ],
  selected: null, // { type: 'node'|'edge', key: string }
  nextId: 3,
};

const graphEl = document.querySelector('#graph');
const graphPane = document.querySelector('#graph-pane');
const dotPane = document.querySelector('#dot-pane');
const dotEl = document.querySelector('#dot');
const statusEl = document.querySelector('#status');
const dragLine = document.querySelector('#drag-line line');
const dragSvg = document.querySelector('#drag-line');
const btnSave = document.querySelector('#btn-save');
const btnLoad = document.querySelector('#btn-load');
const btnToggleDot = document.querySelector('#btn-toggle-dot');
const fileInput = document.querySelector('#file-input');
const renameInput = document.createElement('input');
dragSvg.style.display = 'none';
renameInput.type = 'text';
renameInput.id = 'inline-rename';
renameInput.hidden = true;
graphPane.appendChild(renameInput);

let viz = null;
let renderToken = 0;
let suppressDotSync = false;
let renameSession = null; // { type: 'node'|'edge', key: string, initialValue: string }
let pendingRename = null; // { type: 'node'|'edge', key: string }

// ---------- Helpers ----------
function freshNodeId() {
  while (state.nodes.some((n) => n.id === `n${state.nextId}`)) state.nextId++;
  return `n${state.nextId++}`;
}

function edgeKey(e) { return `${e.from}->${e.to}`; }
function isTextEditingElement(el) {
  return !!(el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable));
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', !!isError);
}

// ---------- Rendering ----------
async function ensureViz() {
  if (!viz) viz = await vizInstance();
  return viz;
}

async function render({ updateDotText = true } = {}) {
  const token = ++renderToken;
  const dot = serialize(state);

  if (updateDotText && document.activeElement !== dotEl) {
    suppressDotSync = true;
    dotEl.value = dot;
    suppressDotSync = false;
    dotEl.classList.remove('invalid');
  }

  let svgEl;
  try {
    const v = await ensureViz();
    if (token !== renderToken) return; // a newer render started
    svgEl = v.renderSVGElement(dot);
  } catch (err) {
    setStatus(`Render error: ${err.message}`, true);
    return;
  }
  if (token !== renderToken) return;

  graphEl.innerHTML = '';
  graphEl.appendChild(svgEl);
  // Let the SVG fill the pane.
  svgEl.removeAttribute('width');
  svgEl.removeAttribute('height');
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  attachGraphInteractions(svgEl);
  reapplySelection(svgEl);
  if (renameSession && !positionRenameInput(svgEl, renameSession)) {
    closeRenameEditor();
  }
  if (!renameSession && pendingRename) {
    const next = pendingRename;
    pendingRename = null;
    openRenameEditor(next.type, next.key);
  }
  setStatus(`${state.nodes.length} node(s), ${state.edges.length} edge(s)`);
}

function reapplySelection(svgEl) {
  if (!state.selected) return;
  if (state.selected.type === 'node') {
    const g = findNodeGroup(svgEl, state.selected.key);
    if (g) g.classList.add('selected');
  } else {
    const g = findEdgeGroup(svgEl, state.selected.key);
    if (g) g.classList.add('selected');
  }
}

// ---------- Mapping SVG elements <-> model ----------
// Graphviz emits each node as <g class="node"><title>ID</title>...</g>
// and each edge as <g class="edge"><title>from->to</title>...</g>.
function getTitle(g) {
  const t = g.querySelector(':scope > title');
  return t ? t.textContent : '';
}
function findNodeGroup(svgEl, id) {
  for (const g of svgEl.querySelectorAll('g.node')) {
    if (getTitle(g) === id) return g;
  }
  return null;
}
function findEdgeGroup(svgEl, key) {
  for (const g of svgEl.querySelectorAll('g.edge')) {
    if (getTitle(g) === key) return g;
  }
  return null;
}

// ---------- Interaction wiring ----------
let dragState = null; // { fromId, startX, startY }

// Add a transparent, wide-stroke overlay over each edge's path (and arrowhead
// polygon if present) so clicks within ~8 px of the line still select the edge.
// The overlay is inserted as the first child of the edge group so the visible
// edge paints on top. The existing click handler on g.edge continues to fire
// regardless of which element inside the group received the event.
// Styles are set inline so the hover/selected CSS rules on `.edge path` /
// `.edge polygon` cannot make the hit area visible.
const SVG_NS = 'http://www.w3.org/2000/svg';
const EDGE_HIT_STYLE = 'stroke:transparent;fill:transparent;cursor:pointer;';
function addEdgeHitArea(edgeGroup) {
  const visiblePath = edgeGroup.querySelector(':scope > path');
  const d = visiblePath ? visiblePath.getAttribute('d') : null;
  if (d) {
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('stroke-width', '14');
    hit.setAttribute('pointer-events', 'stroke');
    hit.setAttribute('class', 'edge-hit-area');
    hit.setAttribute('style', EDGE_HIT_STYLE);
    edgeGroup.insertBefore(hit, edgeGroup.firstChild);
  }
  const arrowhead = edgeGroup.querySelector(':scope > polygon');
  const points = arrowhead ? arrowhead.getAttribute('points') : null;
  if (points) {
    const hit = document.createElementNS(SVG_NS, 'polygon');
    hit.setAttribute('points', points);
    hit.setAttribute('stroke-width', '14');
    hit.setAttribute('pointer-events', 'all');
    hit.setAttribute('class', 'edge-hit-area');
    hit.setAttribute('style', EDGE_HIT_STYLE);
    edgeGroup.insertBefore(hit, edgeGroup.firstChild);
  }
}

function beginDragFromNode(id, clientX, clientY) {
  const rect = graphPane.getBoundingClientRect();
  dragState = {
    fromId: id,
    startX: clientX - rect.left,
    startY: clientY - rect.top,
    moved: false,
  };
  dragLine.setAttribute('x1', dragState.startX);
  dragLine.setAttribute('y1', dragState.startY);
  dragLine.setAttribute('x2', dragState.startX);
  dragLine.setAttribute('y2', dragState.startY);
}

function updateDragTo(clientX, clientY) {
  if (!dragState) return;
  const rect = graphPane.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const dx = x - dragState.startX;
  const dy = y - dragState.startY;
  if (!dragState.moved && Math.hypot(dx, dy) > 4) {
    dragState.moved = true;
    dragSvg.style.display = 'block';
  }
  dragLine.setAttribute('x2', x);
  dragLine.setAttribute('y2', y);
}

function finishDragAt(clientX, clientY) {
  if (!dragState) return;
  const ds = dragState;
  dragState = null;
  dragSvg.style.display = 'none';
  if (!ds.moved) return;

  // Determine target: did we end over a node?
  const targetEl = document.elementFromPoint(clientX, clientY);
  const targetNodeGroup = targetEl ? targetEl.closest('g.node') : null;
  if (targetNodeGroup) {
    const targetId = getTitle(targetNodeGroup);
    if (targetId && targetId !== ds.fromId) {
      addEdge(ds.fromId, targetId);
    }
    return;
  }
  // Only treat as "drop on empty" if we ended inside the graph pane.
  const paneRect = graphPane.getBoundingClientRect();
  if (
    clientX >= paneRect.left && clientX <= paneRect.right &&
    clientY >= paneRect.top && clientY <= paneRect.bottom
  ) {
    const newId = addNode();
    addEdge(ds.fromId, newId);
  }
}

function cancelDrag() {
  if (!dragState) return;
  dragState = null;
  dragSvg.style.display = 'none';
}

function attachGraphInteractions(svgEl) {
  // Node interactions
  for (const g of svgEl.querySelectorAll('g.node')) {
    const id = getTitle(g);

    g.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      beginDragFromNode(id, ev.clientX, ev.clientY);
    });

    // Touch support: start a drag on touchstart with a single finger.
    g.addEventListener('touchstart', (ev) => {
      if (ev.touches.length !== 1) return;
      ev.stopPropagation();
      const t = ev.touches[0];
      beginDragFromNode(id, t.clientX, t.clientY);
    }, { passive: true });

    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectNode(id);
    });

    g.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      renameNode(id);
    });
  }

  // Edge interactions
  for (const g of svgEl.querySelectorAll('g.edge')) {
    const key = getTitle(g);
    addEdgeHitArea(g);
    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectEdge(key);
    });
    g.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      renameEdge(key);
    });
  }
}

// Pane-level handlers (background clicks / dbl-clicks, drag completion).
graphPane.addEventListener('mousemove', (ev) => {
  if (!dragState) return;
  updateDragTo(ev.clientX, ev.clientY);
});

// Touch equivalent of mousemove. Registered non-passive so we can call
// preventDefault() while a drag is in progress to stop the page from scrolling
// or pinch-zooming as the user moves their finger from a node.
graphPane.addEventListener('touchmove', (ev) => {
  if (!dragState) return;
  if (ev.touches.length !== 1) return;
  ev.preventDefault();
  const t = ev.touches[0];
  updateDragTo(t.clientX, t.clientY);
}, { passive: false });

window.addEventListener('mouseup', (ev) => {
  if (!dragState) return;
  finishDragAt(ev.clientX, ev.clientY);
});

// Touch equivalent of mouseup. The original touch target receives touchend
// regardless of where the finger lifts, so we rely on document.elementFromPoint
// inside finishDragAt to determine the actual drop target.
window.addEventListener('touchend', (ev) => {
  if (!dragState) return;
  const t = ev.changedTouches[0];
  if (!t) {
    cancelDrag();
    return;
  }
  finishDragAt(t.clientX, t.clientY);
});

window.addEventListener('touchcancel', () => {
  cancelDrag();
});

graphPane.addEventListener('click', (ev) => {
  // Ignore clicks that originated on a node/edge (those stopPropagation already).
  if (ev.target.closest('g.node, g.edge')) return;
  clearSelection();
});

graphPane.addEventListener('dblclick', (ev) => {
  if (ev.target.closest('g.node, g.edge')) return;
  addNode(undefined, { select: true, rename: true });
});

renameInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    ev.stopPropagation();
    commitRenameEditor();
    return;
  }
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    cancelRenameEditor();
  }
});

renameInput.addEventListener('blur', () => {
  if (!renameSession) return;
  commitRenameEditor();
});

// Keyboard: delete selection + rename shortcuts.
window.addEventListener('keydown', (ev) => {
  const ae = document.activeElement;
  if (isTextEditingElement(ae)) return;
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && state.selected) {
    ev.preventDefault();
    deleteSelection();
    return;
  }
  if ((ev.key === 'F2' || ev.key === 'Enter') && state.selected) {
    ev.preventDefault();
    if (state.selected.type === 'node') renameNode(state.selected.key);
    else renameEdge(state.selected.key);
  }
});

// ---------- Model mutations ----------
function addNode(label, { select = false, rename = false } = {}) {
  const id = freshNodeId();
  const lbl = label ?? id.toUpperCase();
  state.nodes.push({ id, label: lbl });
  const shouldSelect = select || rename;
  if (shouldSelect) state.selected = { type: 'node', key: id };
  if (rename) pendingRename = { type: 'node', key: id };
  render();
  return id;
}

function addEdge(from, to) {
  // Avoid exact duplicates (same from/to/label="").
  if (state.edges.some((e) => e.from === from && e.to === to && !e.label)) {
    render();
    return;
  }
  state.edges.push({ from, to, label: '' });
  render();
}

function renameNode(id) {
  openRenameEditor('node', id);
}

function renameEdge(key) {
  openRenameEditor('edge', key);
}

function selectNode(id) {
  state.selected = { type: 'node', key: id };
  render();
}

function selectEdge(key) {
  state.selected = { type: 'edge', key };
  render();
}

function clearSelection() {
  if (!state.selected) return;
  state.selected = null;
  render();
}

function deleteSelection() {
  if (!state.selected) return;
  if (state.selected.type === 'node') {
    const id = state.selected.key;
    state.nodes = state.nodes.filter((n) => n.id !== id);
    state.edges = state.edges.filter((e) => e.from !== id && e.to !== id);
  } else {
    const [from, to] = state.selected.key.split('->');
    // Remove the first matching edge (model may not have duplicates anyway).
    const idx = state.edges.findIndex((e) => e.from === from && e.to === to);
    if (idx >= 0) state.edges.splice(idx, 1);
  }
  state.selected = null;
  render();
}

function getRenameValue(type, key) {
  if (type === 'node') {
    const node = state.nodes.find((n) => n.id === key);
    return node ? node.label : null;
  }
  const [from, to] = key.split('->');
  const edge = state.edges.find((e) => e.from === from && e.to === to);
  return edge ? (edge.label ?? '') : null;
}

function findRenameAnchorRect(svgEl, type, key) {
  const group = type === 'node' ? findNodeGroup(svgEl, key) : findEdgeGroup(svgEl, key);
  if (!group) return null;
  const label = group.querySelector('text');
  if (label) return label.getBoundingClientRect();
  if (type === 'edge') {
    const path = group.querySelector(':scope > path');
    if (path) return path.getBoundingClientRect();
  }
  return group.getBoundingClientRect();
}

function positionRenameInput(svgEl, session) {
  const anchorRect = findRenameAnchorRect(svgEl, session.type, session.key);
  if (!anchorRect) return false;
  const paneRect = graphPane.getBoundingClientRect();
  const width = Math.max(72, Math.round(anchorRect.width + 16));
  const height = Math.max(24, Math.round(anchorRect.height + 8));
  const left = Math.round(anchorRect.left - paneRect.left + (anchorRect.width - width) / 2);
  const top = Math.round(anchorRect.top - paneRect.top + (anchorRect.height - height) / 2);
  renameInput.style.left = `${Math.max(0, left)}px`;
  renameInput.style.top = `${Math.max(0, top)}px`;
  renameInput.style.width = `${width}px`;
  renameInput.style.height = `${height}px`;
  return true;
}

function closeRenameEditor() {
  renameSession = null;
  renameInput.hidden = true;
}

function cancelRenameEditor() {
  closeRenameEditor();
}

function commitRenameEditor() {
  if (!renameSession) return;
  const session = renameSession;
  const next = renameInput.value;
  closeRenameEditor();
  if (next === '') return;
  if (session.type === 'node') {
    const node = state.nodes.find((n) => n.id === session.key);
    if (!node || node.label === next) return;
    node.label = next;
  } else {
    const [from, to] = session.key.split('->');
    const edge = state.edges.find((e) => e.from === from && e.to === to);
    if (!edge || (edge.label ?? '') === next) return;
    edge.label = next;
  }
  render();
}

function openRenameEditor(type, key) {
  if (renameSession) commitRenameEditor();
  const initialValue = getRenameValue(type, key);
  if (initialValue == null) return;
  const svgEl = graphEl.querySelector('svg');
  if (!svgEl) return;
  renameSession = { type, key, initialValue };
  renameInput.value = initialValue;
  renameInput.hidden = false;
  if (!positionRenameInput(svgEl, renameSession)) {
    closeRenameEditor();
    return;
  }
  renameInput.focus();
  renameInput.select();
}

// ---------- DOT textarea: edits drive the model ----------
dotEl.addEventListener('input', () => {
  if (suppressDotSync) return;
  const src = dotEl.value;
  try {
    const parsed = parse(src);
    state.nodes = parsed.nodes;
    state.edges = parsed.edges;
    // Drop selection if it no longer refers to a real element.
    if (state.selected) {
      if (state.selected.type === 'node' && !state.nodes.some((n) => n.id === state.selected.key)) {
        state.selected = null;
      } else if (state.selected.type === 'edge') {
        const [f, t] = state.selected.key.split('->');
        if (!state.edges.some((e) => e.from === f && e.to === t)) state.selected = null;
      }
    }
    dotEl.classList.remove('invalid');
    render({ updateDotText: false });
  } catch (err) {
    dotEl.classList.add('invalid');
    setStatus(err.message, true);
  }
});

// ---------- DOT pane visibility (persisted) ----------
const DOT_PANE_STORAGE_KEY = 'autograph.dotPane.visible';

function isDotPaneVisible() {
  try {
    return window.localStorage.getItem(DOT_PANE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function applyDotPaneVisibility(visible) {
  dotPane.hidden = !visible;
  btnToggleDot.textContent = visible ? 'Hide DOT' : 'Show DOT';
  btnToggleDot.setAttribute('aria-pressed', visible ? 'true' : 'false');
}

function setDotPaneVisible(visible) {
  applyDotPaneVisibility(visible);
  try {
    window.localStorage.setItem(DOT_PANE_STORAGE_KEY, visible ? 'true' : 'false');
  } catch {
    // ignore quota / disabled storage
  }
}

btnToggleDot.addEventListener('click', () => {
  setDotPaneVisible(dotPane.hidden);
});

applyDotPaneVisibility(isDotPaneVisible());

// ---------- Save / Load ----------
function sanitizeFilename(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'graph';
}

btnSave.addEventListener('click', () => {
  const text = serialize(state);
  const base = sanitizeFilename(state.name);
  const filename = `${base}.dot`;
  const blob = new Blob([text], { type: 'text/vnd.graphviz' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a brief delay so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Saved ${filename}`);
});

btnLoad.addEventListener('click', () => {
  // Reset so selecting the same file again still triggers change.
  fileInput.value = '';
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = parse(text); // throws on malformed DOT
    state.nodes = parsed.nodes;
    state.edges = parsed.edges;
    state.selected = null;
    // Reset nextId to avoid colliding with imported ids like n1, n2, ...
    state.nextId = 1;
    // Use the file's base name as the suggested save name.
    state.name = file.name.replace(/\.[^.]+$/, '') || 'graph';
    dotEl.classList.remove('invalid');
    render();
    setStatus(`Loaded ${file.name}`);
  } catch (err) {
    // Non-blocking error: leave state untouched.
    setStatus(`Failed to load ${file.name}: ${err.message}`, true);
  }
});

// ---------- Boot ----------
render();
