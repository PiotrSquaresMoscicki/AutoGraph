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
      <button id="btn-fit" type="button">Fit</button>
      <button id="btn-toggle-dot" type="button">Show DOT</button>
      <input id="file-input" type="file" accept=".dot,.gv,text/vnd.graphviz,text/plain" hidden />
    </span>
  </header>
  <main>
    <div id="graph-pane" tabindex="0">
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
  viewport: { tx: 0, ty: 0, s: 1 },
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
const btnFit = document.querySelector('#btn-fit');
const btnToggleDot = document.querySelector('#btn-toggle-dot');
const fileInput = document.querySelector('#file-input');
const renameInput = document.createElement('input');
dragSvg.style.display = 'none';
renameInput.type = 'text';
renameInput.id = 'inline-rename';
renameInput.hidden = true;
graphPane.appendChild(renameInput);

// ---------- Viewport ----------
// Persistent SVG canvas that fills the pane; Graphviz content lives inside
// a <g id="viewport"> so we can pan/zoom by changing its transform attribute.
const SVG_NS = 'http://www.w3.org/2000/svg';
const graphSvg = document.createElementNS(SVG_NS, 'svg');
graphSvg.setAttribute('width', '100%');
graphSvg.setAttribute('height', '100%');
const viewportGroup = document.createElementNS(SVG_NS, 'g');
viewportGroup.id = 'viewport';
graphSvg.appendChild(viewportGroup);
graphEl.appendChild(graphSvg);

let viz = null;
let renderToken = 0;
let suppressDotSync = false;
let renameSession = null; // { type: 'node'|'edge', key: string, initialValue: string }
let pendingRename = null; // { type: 'node'|'edge', key: string }
let panState = null;         // { startX, startY, startTx, startTy }
let needsInitialFit = true; // fit content into view after the first render

// ---------- History ----------
const HISTORY_LIMIT = 100;
const undoStack = [];
const redoStack = [];
let dotDebounceTimer = null;
// When true, addEdge and commitRenameEditor skip pushSnapshot so that
// the create-node + create-edge + rename sequence is a single undo step.
let compositeAction = false;

// ---------- Helpers ----------
function freshNodeId() {
  while (state.nodes.some((n) => n.id === `n${state.nextId}`)) state.nextId++;
  return `n${state.nextId++}`;
}

function edgeKey(e) { return `${e.from}->${e.to}`; }
function isTextEditingElement(el) {
  return !!(el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable));
}

// ---------- Viewport helpers ----------
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;

function applyViewportTransform() {
  const { tx, ty, s } = state.viewport;
  viewportGroup.setAttribute('transform', `translate(${tx},${ty}) scale(${s})`);
}

// Convert pane-local coordinates to world (graph) coordinates.
function screenToWorld(paneX, paneY) {
  const { tx, ty, s } = state.viewport;
  return { x: (paneX - tx) / s, y: (paneY - ty) / s };
}

// Convert world (graph) coordinates to pane-local screen coordinates.
function worldToScreen(worldX, worldY) {
  const { tx, ty, s } = state.viewport;
  return { x: worldX * s + tx, y: worldY * s + ty };
}

// Zoom by `factor`, keeping the point (pivotX, pivotY) in pane-local coords fixed.
function zoomBy(factor, pivotX, pivotY) {
  const { tx, ty, s } = state.viewport;
  const newS = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s * factor));
  if (newS === s) return;
  state.viewport.s = newS;
  state.viewport.tx = pivotX - (pivotX - tx) * (newS / s);
  state.viewport.ty = pivotY - (pivotY - ty) * (newS / s);
  applyViewportTransform();
}

// Fit all graph content into the pane with padding.
function fitContent() {
  const paneRect = graphPane.getBoundingClientRect();
  if (!paneRect.width || !paneRect.height) return;
  let bbox;
  try { bbox = viewportGroup.getBBox(); } catch { return; }
  if (!bbox || !bbox.width || !bbox.height) return;
  const PAD = 40;
  const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN,
    Math.min((paneRect.width - PAD * 2) / bbox.width,
             (paneRect.height - PAD * 2) / bbox.height)));
  state.viewport.s = s;
  state.viewport.tx = (paneRect.width - bbox.width * s) / 2 - bbox.x * s;
  state.viewport.ty = (paneRect.height - bbox.height * s) / 2 - bbox.y * s;
  applyViewportTransform();
}

// Reset to 1:1 scale, centering the content.
function resetViewport() {
  const paneRect = graphPane.getBoundingClientRect();
  state.viewport.s = 1;
  let bbox;
  try { bbox = viewportGroup.getBBox(); } catch { /* ignore */ }
  if (bbox && bbox.width) {
    state.viewport.tx = (paneRect.width - bbox.width) / 2 - bbox.x;
    state.viewport.ty = (paneRect.height - bbox.height) / 2 - bbox.y;
  } else {
    state.viewport.tx = 0;
    state.viewport.ty = 0;
  }
  applyViewportTransform();
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', !!isError);
}

// ---------- History helpers ----------
function snapshotState() {
  return structuredClone({
    name: state.name,
    nodes: state.nodes,
    edges: state.edges,
    selected: state.selected,
    nextId: state.nextId,
  });
}

function pushSnapshot() {
  undoStack.push(snapshotState());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function restoreState(snapshot) {
  state.name = snapshot.name;
  state.nodes = snapshot.nodes;
  state.edges = snapshot.edges;
  state.selected = snapshot.selected;
  state.nextId = snapshot.nextId;
}

function undo() {
  clearTimeout(dotDebounceTimer);
  dotDebounceTimer = null;
  if (undoStack.length === 0) return;
  redoStack.push(snapshotState());
  restoreState(undoStack.pop());
  render();
}

function redo() {
  clearTimeout(dotDebounceTimer);
  dotDebounceTimer = null;
  if (redoStack.length === 0) return;
  undoStack.push(snapshotState());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  restoreState(redoStack.pop());
  render();
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

  // Transfer Graphviz SVG children into the persistent viewport group.
  // The Graphviz SVG element itself is discarded; only its children are used.
  viewportGroup.innerHTML = '';
  while (svgEl.firstChild) {
    viewportGroup.appendChild(svgEl.firstChild);
  }
  applyViewportTransform();

  attachGraphInteractions(graphSvg);
  reapplySelection(graphSvg);
  // On re-render try to reposition the rename input over its label. If the
  // label can no longer be found (e.g. the renamed element was deleted) close
  // the editor. Note: pan/zoom does not trigger a re-render; those code paths
  // close the editor directly in their event handlers.
  if (renameSession && !positionRenameInput(graphSvg, renameSession)) {
    closeRenameEditor();
  }
  if (!renameSession && pendingRename) {
    const next = pendingRename;
    pendingRename = null;
    openRenameEditor(next.type, next.key);
  }
  // Fit content into view on the very first render.
  if (needsInitialFit) {
    needsInitialFit = false;
    requestAnimationFrame(fitContent);
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
    const newId = addNode(undefined, { select: true, rename: true });
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

// Pan: mousedown on the SVG background (not on a node/edge) starts a pan.
// Node/edge mousedown handlers call stopPropagation so they won't trigger this.
graphSvg.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  if (dragState) return; // a node drag-to-connect is active
  ev.preventDefault();
  panState = {
    startX: ev.clientX,
    startY: ev.clientY,
    startTx: state.viewport.tx,
    startTy: state.viewport.ty,
  };
  graphPane.style.cursor = 'grabbing';
});

// Pan mousemove on window so panning continues even when cursor leaves the pane.
window.addEventListener('mousemove', (ev) => {
  if (!panState) return;
  state.viewport.tx = panState.startTx + (ev.clientX - panState.startX);
  state.viewport.ty = panState.startTy + (ev.clientY - panState.startY);
  applyViewportTransform();
  if (renameSession) closeRenameEditor();
});

window.addEventListener('mouseup', (ev) => {
  if (dragState) finishDragAt(ev.clientX, ev.clientY);
  if (panState) {
    panState = null;
    graphPane.style.cursor = '';
  }
});

// Wheel zoom — centered on cursor position.
// When ctrlKey is set the browser is forwarding a trackpad pinch gesture.
graphPane.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  if (renameSession) closeRenameEditor();
  const rect = graphPane.getBoundingClientRect();
  const pivotX = ev.clientX - rect.left;
  const pivotY = ev.clientY - rect.top;
  // Pinch (ctrlKey) sends much smaller deltaY values than a mouse wheel; the
  // larger multiplier (0.04 vs 0.001) compensates so both feel similarly paced.
  const delta = ev.ctrlKey ? ev.deltaY * 0.04 : ev.deltaY * 0.001;
  zoomBy(Math.exp(-delta), pivotX, pivotY);
}, { passive: false });

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
  graphPane.focus({ preventScroll: true });
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
    graphPane.focus({ preventScroll: true });
    return;
  }
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    cancelRenameEditor();
    graphPane.focus({ preventScroll: true });
  }
});

renameInput.addEventListener('blur', () => {
  if (!renameSession) return;
  commitRenameEditor();
});

// Keyboard: delete selection + rename shortcuts + undo/redo.
window.addEventListener('keydown', (ev) => {
  const ae = document.activeElement;

  // Undo/redo: active everywhere except non-DOT text fields so the browser's
  // native text undo is preserved in <input> / contenteditable elements, but
  // the DOT textarea round-trips through graph history instead.
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey) {
    const inOtherTextField = isTextEditingElement(ae) && ae !== dotEl;
    if (!inOtherTextField) {
      if (ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
        ev.preventDefault();
        undo();
        return;
      }
      if ((ev.key.toLowerCase() === 'z' && ev.shiftKey) || ev.key.toLowerCase() === 'y') {
        ev.preventDefault();
        redo();
        return;
      }
    }
  }

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
  // Viewport keyboard shortcuts: +/= zoom in, - zoom out, 0 reset 1:1.
  if (ev.key === '+' || ev.key === '=') {
    ev.preventDefault();
    const r = graphPane.getBoundingClientRect();
    zoomBy(1.2, r.width / 2, r.height / 2);
    return;
  }
  if (ev.key === '-') {
    ev.preventDefault();
    const r = graphPane.getBoundingClientRect();
    zoomBy(1 / 1.2, r.width / 2, r.height / 2);
    return;
  }
  if (ev.key === '0') {
    ev.preventDefault();
    resetViewport();
    return;
  }
  // Tab: create a connected node and enter rename mode (one undo step).
  // Shift+Tab: same but with reversed edge direction (new → selected).
  // addNode with rename:true sets compositeAction=true so addEdge below
  // skips its own pushSnapshot — the whole sequence is one undo entry.
  if (ev.key === 'Tab' && state.selected?.type === 'node' && ae === graphPane) {
    ev.preventDefault();
    const fromId = state.selected.key;
    const newId = addNode(undefined, { select: true, rename: true });
    if (ev.shiftKey) {
      addEdge(newId, fromId);
    } else {
      addEdge(fromId, newId);
    }
  }
});

// ---------- Model mutations ----------
function addNode(label, { select = false, rename = false } = {}) {
  pushSnapshot();
  const id = freshNodeId();
  const lbl = label ?? id.toUpperCase();
  state.nodes.push({ id, label: lbl });
  const shouldSelect = select || rename;
  if (shouldSelect) state.selected = { type: 'node', key: id };
  if (rename) {
    pendingRename = { type: 'node', key: id };
    // Mark a composite transaction: the following addEdge (triggered by
    // finishDragAt after dropping on empty space) and commitRenameEditor
    // both belong to the same undo step as this addNode, so they skip
    // their own pushSnapshot calls.
    compositeAction = true;
  }
  render();
  return id;
}

function addEdge(from, to) {
  // Avoid exact duplicates (same from/to/label="").
  if (state.edges.some((e) => e.from === from && e.to === to && !e.label)) {
    render();
    return;
  }
  if (!compositeAction) pushSnapshot();
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
  graphPane.focus({ preventScroll: true });
}

function selectEdge(key) {
  state.selected = { type: 'edge', key };
  render();
  graphPane.focus({ preventScroll: true });
}

function clearSelection() {
  if (!state.selected) return;
  state.selected = null;
  render();
}

function deleteSelection() {
  if (!state.selected) return;
  pushSnapshot();
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
  // Clear the composite flag. No snapshot is needed here: the snapshot pushed
  // by addNode already covers the entire composite (node + any auto-edge),
  // so Ctrl+Z will undo all of it in one step.
  compositeAction = false;
  closeRenameEditor();
}

function commitRenameEditor() {
  if (!renameSession) return;
  const session = renameSession;
  const next = renameInput.value;
  const wasComposite = compositeAction;
  compositeAction = false;
  closeRenameEditor();
  if (next === '') return;
  if (session.type === 'node') {
    const node = state.nodes.find((n) => n.id === session.key);
    if (!node || node.label === next) return;
    if (!wasComposite) pushSnapshot();
    node.label = next;
  } else {
    const [from, to] = session.key.split('->');
    const edge = state.edges.find((e) => e.from === from && e.to === to);
    if (!edge || (edge.label ?? '') === next) return;
    if (!wasComposite) pushSnapshot();
    edge.label = next;
  }
  render();
}

function openRenameEditor(type, key) {
  if (renameSession) commitRenameEditor();
  const initialValue = getRenameValue(type, key);
  if (initialValue == null) return;
  renameSession = { type, key, initialValue };
  renameInput.value = initialValue;
  renameInput.hidden = false;
  if (!positionRenameInput(graphSvg, renameSession)) {
    closeRenameEditor();
    return;
  }
  renameInput.focus();
  renameInput.select();
}

// ---------- DOT textarea: edits drive the model ----------
dotEl.addEventListener('input', () => {
  if (suppressDotSync) return;
  // Debounced snapshot: one undo step per continuous typing burst.
  if (dotDebounceTimer === null) {
    pushSnapshot(); // capture state before this burst
  }
  clearTimeout(dotDebounceTimer);
  dotDebounceTimer = setTimeout(() => { dotDebounceTimer = null; }, 400);
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

btnFit.addEventListener('click', fitContent);

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
    pushSnapshot();
    state.nodes = parsed.nodes;
    state.edges = parsed.edges;
    state.selected = null;
    // Reset nextId to avoid colliding with imported ids like n1, n2, ...
    state.nextId = 1;
    // Use the file's base name as the suggested save name.
    state.name = file.name.replace(/\.[^.]+$/, '') || 'graph';
    dotEl.classList.remove('invalid');
    await render();
    requestAnimationFrame(fitContent);
    setStatus(`Loaded ${file.name}`);
  } catch (err) {
    // Non-blocking error: leave state untouched.
    setStatus(`Failed to load ${file.name}: ${err.message}`, true);
  }
});

// ---------- Boot ----------
render();
