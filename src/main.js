import './style.css';
import { select as d3select } from 'd3-selection';
import { transition as d3transition } from 'd3-transition';
// Side-effect import: extends d3-selection's selection prototype with
// .graphviz(), used below on d3select(graphEl).
import 'd3-graphviz';
import { serialize, parse } from './dot.js';

// ---------- Layout ----------
document.querySelector('#app').innerHTML = `
  <header>
    <h1>AutoGraph</h1>
    <span class="header-actions">
      <button id="btn-new" type="button">New</button>
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
      <svg id="marquee-layer"><rect x="0" y="0" width="0" height="0"/></svg>
    </div>
    <div id="dot-pane">
      <label for="dot">DOT source (single source of truth)</label>
      <textarea id="dot" spellcheck="false"></textarea>
      <div id="status"></div>
    </div>
  </main>
  <div id="rename-modal" hidden>
    <form id="rename-dialog">
      <h2 id="rename-title" aria-live="polite">Rename</h2>
      <label id="rename-label" for="rename-input">Name</label>
      <input id="rename-input" type="text" spellcheck="false" />
      <div class="rename-actions">
        <button id="rename-cancel" type="button">Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>
  </div>
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
  selected: new Set(), // Set<'node:key' | 'edge:key'>
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
const marqueeSvg = document.querySelector('#marquee-layer');
const marqueeRect = document.querySelector('#marquee-layer rect');
const btnNew = document.querySelector('#btn-new');
const btnSave = document.querySelector('#btn-save');
const btnLoad = document.querySelector('#btn-load');
const btnFit = document.querySelector('#btn-fit');
const btnToggleDot = document.querySelector('#btn-toggle-dot');
const fileInput = document.querySelector('#file-input');
const renameModal = document.querySelector('#rename-modal');
const renameDialog = document.querySelector('#rename-dialog');
const renameTitle = document.querySelector('#rename-title');
const renameLabel = document.querySelector('#rename-label');
const renameInput = document.querySelector('#rename-input');
const btnRenameCancel = document.querySelector('#rename-cancel');
dragSvg.style.display = 'none';
marqueeSvg.style.display = 'none';

// ---------- Viewport ----------
// d3-graphviz manages its own <svg> inside #graph. We pan/zoom by manipulating
// the SVG's viewBox attribute, leaving Graphviz's intrinsic transform on the
// root <g id="graph0"> alone. This way d3-transition's tweening of element
// transforms during render transitions does not conflict with our viewport.
// The attributer below ensures the SVG sizing and viewBox match our viewport
// state on every render, including during animated transitions.
const SVG_NS = 'http://www.w3.org/2000/svg';

function viewBoxForState() {
  const pr = graphPane.getBoundingClientRect();
  const { tx, ty, s } = state.viewport;
  // Choose vx,vy,vw,vh so that world coords map to pane pixels via
  //   screen_x = world_x * s + tx   (same math as the old viewport transform).
  // SVG: screen_x = (world_x - vx) / vw * paneW, with width = paneW pixels.
  // → vw = paneW / s, vx = -tx / s (same for y).
  const safeS = s || 1;
  return {
    width: pr.width,
    height: pr.height,
    viewBox: `${-tx / safeS} ${-ty / safeS} ${pr.width / safeS} ${pr.height / safeS}`,
  };
}

function graphAttributer(datum) {
  if (datum.tag === 'svg') {
    const vb = viewBoxForState();
    datum.attributes.width = vb.width;
    datum.attributes.height = vb.height;
    datum.attributes.viewBox = vb.viewBox;
    // Avoid Graphviz's default preserveAspectRatio="xMidYMid meet" centering,
    // which would shift content unpredictably while we drive the viewBox.
    datum.attributes.preserveAspectRatio = 'xMinYMin meet';
  }
}

const graphvizRenderer = d3select(graphEl)
  .graphviz({ useWorker: false })
  .zoom(false)
  .attributer(graphAttributer);

// Returns the d3-graphviz-managed <svg> element (or null before first render).
function currentGraphSvg() {
  return graphEl.querySelector('svg');
}

// Returns the root <g class="graph"> (i.e. <g id="graph0">) or null.
function currentGraphRootG() {
  const svg = currentGraphSvg();
  return svg ? svg.querySelector(':scope > g.graph') : null;
}

let renderToken = 0;
let suppressDotSync = false;
let renameSession = null; // { type: 'node'|'edge', key: string, initialValue: string }
let panState = null;         // { startX, startY, startTx, startTy }
let pinchState = null;       // { startDist, startMidX, startMidY, startTx, startTy, startS }
let marqueeState = null;     // { startX, startY, x, y, width, height, additive, moved }
let suppressNextBackgroundClick = false;
// Double-tap detection for touch devices (browser won't synthesise dblclick when
// touch-action:none is set).  Tracks the most recent single-finger background tap.
let lastBackgroundTap = null; // { x, y, time } | null
const DOUBLE_TAP_MS = 300;   // max ms between taps to count as double-tap
const DOUBLE_TAP_PX = 30;    // max movement (px) for a touch to count as a tap
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
function selectionRef(type, key) { return `${type}:${key}`; }
function isGraphElementTarget(target) {
  return !!target?.closest?.('g.node, g.edge');
}
function parseSelectionRef(ref) {
  const i = ref.indexOf(':');
  if (i < 0) return null;
  const type = ref.slice(0, i);
  const key = ref.slice(i + 1);
  if ((type !== 'node' && type !== 'edge') || !key) return null;
  return { type, key };
}
function normalizeSelection(rawSelected) {
  if (rawSelected instanceof Set) return rawSelected;
  if (Array.isArray(rawSelected)) return new Set(rawSelected);
  if (rawSelected && rawSelected.type && rawSelected.key) {
    return new Set([selectionRef(rawSelected.type, rawSelected.key)]);
  }
  return new Set();
}
function hasSelection() {
  return state.selected.size > 0;
}
function setSingleSelection(type, key) {
  state.selected.clear();
  state.selected.add(selectionRef(type, key));
}
function toggleSelection(type, key) {
  const ref = selectionRef(type, key);
  if (state.selected.has(ref)) state.selected.delete(ref);
  else state.selected.add(ref);
}
function getSingleSelection() {
  if (state.selected.size !== 1) return null;
  const onlyRef = state.selected.values().next().value;
  return parseSelectionRef(onlyRef);
}

// ---------- Viewport helpers ----------
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;

function applyViewportTransform() {
  const svg = currentGraphSvg();
  if (!svg) return;
  const vb = viewBoxForState();
  svg.setAttribute('width', vb.width);
  svg.setAttribute('height', vb.height);
  svg.setAttribute('viewBox', vb.viewBox);
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

// Distance between two touch points (used for pinch-zoom).
function touchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

// Returns the bounding box of the rendered content in pane (= SVG userspace)
// coordinates with our viewport transform stripped, or null if not available.
// Equivalent to the old viewportGroup.getBBox() in the previous architecture.
function getContentBBoxInPane() {
  const g0 = currentGraphRootG();
  if (!g0) return null;
  const saved = { tx: state.viewport.tx, ty: state.viewport.ty, s: state.viewport.s };
  state.viewport.tx = 0;
  state.viewport.ty = 0;
  state.viewport.s = 1;
  applyViewportTransform();
  let bbox = null;
  try {
    const cr = g0.getBoundingClientRect();
    const pr = graphPane.getBoundingClientRect();
    if (cr.width && cr.height) {
      bbox = {
        x: cr.left - pr.left,
        y: cr.top - pr.top,
        width: cr.width,
        height: cr.height,
      };
    }
  } catch { /* ignore */ }
  state.viewport.tx = saved.tx;
  state.viewport.ty = saved.ty;
  state.viewport.s = saved.s;
  applyViewportTransform();
  return bbox;
}

// Fit all graph content into the pane with padding.
function fitContent() {
  const paneRect = graphPane.getBoundingClientRect();
  if (!paneRect.width || !paneRect.height) return;
  const bbox = getContentBBoxInPane();
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
  const bbox = getContentBBoxInPane();
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
    selected: Array.from(state.selected),
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
  state.selected = normalizeSelection(snapshot.selected);
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
// d3-graphviz animates transitions between successive renders by morphing
// SVG element attributes/shapes via d3 transitions.
const RENDER_TRANSITION_MS = 400;
// Serializes render() calls so that overlapping invocations (which the rest of
// the app commonly fires when several state mutations land close together) do
// not interleave inside d3-graphviz's data-join, which can otherwise see a
// stale DOM (e.g. our injected edge hit-areas) and throw on undefined data.
let pendingRender = Promise.resolve();

async function render({ updateDotText = true } = {}) {
  const token = ++renderToken;
  const dot = serialize(state);

  if (updateDotText && document.activeElement !== dotEl) {
    suppressDotSync = true;
    dotEl.value = dot;
    suppressDotSync = false;
    dotEl.classList.remove('invalid');
  }

  // Wait for any in-flight render to finish before mutating the SVG so that
  // d3-graphviz never sees a half-transitioned DOM with our hit-area overlays.
  const prev = pendingRender;
  let resolveThis;
  pendingRender = new Promise((res) => { resolveThis = res; });
  try {
    await prev;
  } catch { /* swallow earlier errors so subsequent renders still run */ }
  // If a newer render has been queued behind us, skip this one entirely; the
  // most recent dot is what we want to render.
  if (token !== renderToken) { resolveThis(); return; }

  // Strip our injected edge hit-area overlays before re-rendering so
  // d3-graphviz's data-join (keyed by datum) does not encounter children
  // without bound data.
  removeEdgeHitAreas();

  try {
    await new Promise((resolve, reject) => {
      graphvizRenderer
        .transition(() => d3transition().duration(RENDER_TRANSITION_MS))
        .onerror((err) => reject(err))
        // 'renderEnd' fires after the DOM diff but before the animated
        // transition completes. We attach interactions early on 'renderEnd' so
        // listeners are wired up promptly, but defer the final viewport-fit
        // until 'end' (post-transition), because d3-transition keeps writing
        // tweened attribute values onto the SVG (e.g. viewBox) for the whole
        // transition duration and would clobber any manual setAttribute we do
        // mid-transition.
        .on('renderEnd', () => {
          if (token !== renderToken) return;
          const svgEl = currentGraphSvg();
          if (!svgEl) return;
          attachGraphInteractions(svgEl);
          reapplySelection(svgEl);
        })
        .on('end', () => resolve())
        .renderDot(dot);
    });
  } catch (err) {
    setStatus(`Render error: ${err && err.message ? err.message : err}`, true);
    resolveThis();
    return;
  }
  if (token !== renderToken) { resolveThis(); return; } // a newer render started

  const svgEl = currentGraphSvg();
  if (!svgEl) { resolveThis(); return; }

  // After the transition fully ends, settle the SVG to the current viewport
  // (in case state.viewport changed while the transition was running).
  applyViewportTransform();
  reapplySelection(svgEl);
  // Fit content into view on the very first render.
  if (needsInitialFit) {
    needsInitialFit = false;
    requestAnimationFrame(fitContent);
  }
  setStatus(`${state.nodes.length} node(s), ${state.edges.length} edge(s)`);
  saveToCache();
  resolveThis();
}

function reapplySelection(svgEl) {
  if (!hasSelection()) return;
  for (const ref of state.selected) {
    const sel = parseSelectionRef(ref);
    if (!sel) continue;
    if (sel.type === 'node') {
      const g = findNodeGroup(svgEl, sel.key);
      if (g) g.classList.add('selected');
    } else {
      const g = findEdgeGroup(svgEl, sel.key);
      if (g) g.classList.add('selected');
    }
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
// Removes any previously injected edge hit-area overlays so d3-graphviz's
// data-join can iterate edge group children without tripping over elements
// that have no bound datum.
function removeEdgeHitAreas() {
  const svg = currentGraphSvg();
  if (!svg) return;
  for (const el of svg.querySelectorAll('.edge-hit-area')) {
    el.remove();
  }
}

const EDGE_HIT_STYLE = 'stroke:transparent;fill:transparent;cursor:pointer;';
function addEdgeHitArea(edgeGroup) {
  // d3-graphviz reuses DOM elements across renders, so make insertion idempotent.
  if (edgeGroup.querySelector(':scope > .edge-hit-area')) return;
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
    // Suppress the background click that the browser fires after mouseup so it
    // does not immediately close the rename modal that addNode is about to open.
    suppressNextBackgroundClick = true;
    const newId = addNode(undefined, { select: true, rename: true });
    addEdge(ds.fromId, newId);
  }
}

function cancelDrag() {
  if (!dragState) return;
  dragState = null;
  dragSvg.style.display = 'none';
}

function boxesIntersect(a, b) {
  return a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y;
}

function beginMarquee(clientX, clientY, additive) {
  const rect = graphPane.getBoundingClientRect();
  const startX = clientX - rect.left;
  const startY = clientY - rect.top;
  marqueeState = { startX, startY, x: startX, y: startY, width: 0, height: 0, additive, moved: false };
  marqueeRect.setAttribute('x', `${startX}`);
  marqueeRect.setAttribute('y', `${startY}`);
  marqueeRect.setAttribute('width', '0');
  marqueeRect.setAttribute('height', '0');
  marqueeSvg.style.display = 'block';
}

function updateMarquee(clientX, clientY) {
  if (!marqueeState) return;
  const rect = graphPane.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const left = Math.min(marqueeState.startX, x);
  const top = Math.min(marqueeState.startY, y);
  const width = Math.abs(x - marqueeState.startX);
  const height = Math.abs(y - marqueeState.startY);
  marqueeState.x = left;
  marqueeState.y = top;
  marqueeState.width = width;
  marqueeState.height = height;
  marqueeState.moved = marqueeState.moved || width > 2 || height > 2;
  marqueeRect.setAttribute('x', `${left}`);
  marqueeRect.setAttribute('y', `${top}`);
  marqueeRect.setAttribute('width', `${width}`);
  marqueeRect.setAttribute('height', `${height}`);
}

function finishMarquee() {
  if (!marqueeState) return;
  const ms = marqueeState;
  marqueeState = null;
  marqueeSvg.style.display = 'none';
  // After a drag-select, the browser will still fire a background click; suppress
  // it so it does not immediately clear/replace the marquee selection.
  if (ms.moved) suppressNextBackgroundClick = true;
  // With d3-graphviz, content groups are reused across renders (keyed by their
  // <title>), so the marquee iterates the live SVG and hit-tests each node's
  // on-screen bounding box against the marquee rectangle (both in pane coords).
  const screenRect = { x: ms.x, y: ms.y, width: ms.width, height: ms.height };
  const paneRect = graphPane.getBoundingClientRect();
  const selectedNodes = new Set();
  const next = ms.additive ? new Set(state.selected) : new Set();
  const svgEl = currentGraphSvg();
  if (svgEl) {
    for (const g of svgEl.querySelectorAll('g.node')) {
      const id = getTitle(g);
      if (!id) continue;
      let cr;
      try { cr = g.getBoundingClientRect(); } catch {
        // Ignore transient SVG geometry errors and skip this node in marquee hit-test.
        continue;
      }
      const nodeBox = {
        x: cr.left - paneRect.left,
        y: cr.top - paneRect.top,
        width: cr.width,
        height: cr.height,
      };
      if (boxesIntersect(nodeBox, screenRect)) {
        selectedNodes.add(id);
        next.add(selectionRef('node', id));
      }
    }
  }
  // Marquee edge rule: select edges only when both endpoint nodes are selected
  // by the marquee hit-test rectangle.
  for (const e of state.edges) {
    if (selectedNodes.has(e.from) && selectedNodes.has(e.to)) {
      next.add(selectionRef('edge', edgeKey(e)));
    }
  }
  state.selected = next;
  render();
  graphPane.focus({ preventScroll: true });
}

function attachGraphInteractions(svgEl) {
  // d3-graphviz keeps DOM elements alive across renders (matched by <title>
  // key), so we tag elements with __autograph_bound to avoid attaching the same
  // listeners multiple times. New nodes/edges from a render get fresh listeners.
  // Node interactions
  for (const g of svgEl.querySelectorAll('g.node')) {
    if (g.__autograph_bound) continue;
    g.__autograph_bound = true;
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
      if (ev.ctrlKey || ev.metaKey) selectNode(id, { toggle: true });
      else selectNode(id);
    });

    g.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      renameNode(id);
    });
  }

  // Edge interactions
  for (const g of svgEl.querySelectorAll('g.edge')) {
    // addEdgeHitArea is idempotent and must run every render because
    // d3-graphviz may strip our injected hit-area overlay when diffing.
    addEdgeHitArea(g);
    if (g.__autograph_bound) continue;
    g.__autograph_bound = true;
    const key = getTitle(g);
    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (ev.ctrlKey || ev.metaKey) selectEdge(key, { toggle: true });
      else selectEdge(key);
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

// Touch equivalents of mousemove. Registered non-passive so we can call
// preventDefault() to suppress scroll/zoom for all three gesture types:
// node drag-to-connect (dragState), background pan (panState), pinch-zoom (pinchState).
graphPane.addEventListener('touchmove', (ev) => {
  if (dragState) {
    // Node drag-to-connect: forward to the same handler used for mouse.
    if (ev.touches.length !== 1) return;
    ev.preventDefault();
    const t = ev.touches[0];
    updateDragTo(t.clientX, t.clientY);
    return;
  }
  if (panState && ev.touches.length >= 1) {
    // Single-finger background pan.
    ev.preventDefault();
    const t = ev.touches[0];
    state.viewport.tx = panState.startTx + (t.clientX - panState.startX);
    state.viewport.ty = panState.startTy + (t.clientY - panState.startY);
    applyViewportTransform();
    if (renameSession) closeRenameEditor();
    return;
  }
  if (pinchState && ev.touches.length === 2) {
    // Two-finger pinch-zoom with simultaneous pan (tracked via midpoint).
    ev.preventDefault();
    const rect = graphPane.getBoundingClientRect();
    const currentDist = touchDist(ev.touches);
    const currentMidX = (ev.touches[0].clientX + ev.touches[1].clientX) / 2 - rect.left;
    const currentMidY = (ev.touches[0].clientY + ev.touches[1].clientY) / 2 - rect.top;
    // New scale, clamped.
    const newS = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN,
      pinchState.startS * currentDist / pinchState.startDist));
    // Compute the world point that was under the initial midpoint and keep it
    // under the current midpoint (handles combined pan + zoom).
    const wx = (pinchState.startMidX - pinchState.startTx) / pinchState.startS;
    const wy = (pinchState.startMidY - pinchState.startTy) / pinchState.startS;
    state.viewport.s = newS;
    state.viewport.tx = currentMidX - wx * newS;
    state.viewport.ty = currentMidY - wy * newS;
    applyViewportTransform();
    if (renameSession) closeRenameEditor();
  }
}, { passive: false });

// Pan: mousedown on the SVG background (not on a node/edge) starts a pan.
// Node/edge mousedown handlers call stopPropagation so they won't trigger this.
// Listen on graphPane since the d3-graphviz <svg> is created lazily and may be
// replaced; overlays inside the pane have pointer-events:none so they don't
// receive these events.
graphPane.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  if (dragState) return; // a node drag-to-connect is active
  if (isGraphElementTarget(ev.target)) return;
  // Ignore mousedown on non-graph UI inside the pane (e.g. the rename input).
  if (!ev.target.closest('#graph')) return;
  ev.preventDefault();
  if (ev.shiftKey) {
    beginMarquee(ev.clientX, ev.clientY, ev.ctrlKey || ev.metaKey);
    graphPane.style.cursor = 'crosshair';
  } else {
    panState = {
      startX: ev.clientX,
      startY: ev.clientY,
      startTx: state.viewport.tx,
      startTy: state.viewport.ty,
    };
    graphPane.style.cursor = 'grabbing';
  }
});

// Touch pan and pinch-zoom: touchstart on the SVG background.
// Node touchstart handlers call stopPropagation, so touches on nodes never
// reach here — only background touches do. Bound to graphPane (delegation)
// because the d3-graphviz <svg> element is created on first render.
graphPane.addEventListener('touchstart', (ev) => {
  if (dragState) return; // node drag-to-connect is active
  if (!ev.target.closest('#graph')) return;
  ev.preventDefault();
  const rect = graphPane.getBoundingClientRect();
  if (ev.touches.length === 1) {
    // Single finger on background: start pan.
    pinchState = null;
    panState = {
      startX: ev.touches[0].clientX,
      startY: ev.touches[0].clientY,
      startTx: state.viewport.tx,
      startTy: state.viewport.ty,
    };
  } else if (ev.touches.length === 2) {
    // Two fingers: start pinch-zoom (also handles simultaneous pan via midpoint).
    // A multi-finger gesture is never a tap, so discard any pending double-tap.
    lastBackgroundTap = null;
    panState = null;
    const midX = (ev.touches[0].clientX + ev.touches[1].clientX) / 2 - rect.left;
    const midY = (ev.touches[0].clientY + ev.touches[1].clientY) / 2 - rect.top;
    pinchState = {
      startDist: touchDist(ev.touches),
      startMidX: midX,
      startMidY: midY,
      startTx: state.viewport.tx,
      startTy: state.viewport.ty,
      startS: state.viewport.s,
    };
  }
}, { passive: false });

// Pan mousemove on window so panning continues even when cursor leaves the pane.
window.addEventListener('mousemove', (ev) => {
  if (marqueeState) {
    updateMarquee(ev.clientX, ev.clientY);
    return;
  }
  if (!panState) return;
  state.viewport.tx = panState.startTx + (ev.clientX - panState.startX);
  state.viewport.ty = panState.startTy + (ev.clientY - panState.startY);
  applyViewportTransform();
  if (renameSession) closeRenameEditor();
});

window.addEventListener('mouseup', (ev) => {
  if (dragState) finishDragAt(ev.clientX, ev.clientY);
  if (marqueeState) finishMarquee();
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

// Touch equivalents of mouseup and touchcancel: end node-drag, pan, or pinch.
window.addEventListener('touchend', (ev) => {
  if (dragState) {
    const t = ev.changedTouches[0];
    if (!t) { cancelDrag(); } else { finishDragAt(t.clientX, t.clientY); }
  }
  // All fingers lifted: clear all states, then check for double-tap.
  if (ev.touches.length === 0) {
    const savedPan = panState;
    const wasPinch = pinchState !== null;
    panState = null;
    pinchState = null;

    // Double-tap detection (browser won't fire dblclick when touch-action:none).
    // A candidate tap: single-finger background touch that barely moved.
    const tapTouch = ev.changedTouches[0];
    if (savedPan && !wasPinch && tapTouch) {
      const moved = Math.hypot(tapTouch.clientX - savedPan.startX, tapTouch.clientY - savedPan.startY);
      if (moved <= DOUBLE_TAP_PX) {
        if (renameSession) {
          commitRenameAndFocusGraph();
          lastBackgroundTap = null;
          return;
        }
        const now = Date.now();
        if (lastBackgroundTap) {
          const dt = now - lastBackgroundTap.time;
          const dist = Math.hypot(tapTouch.clientX - lastBackgroundTap.x, tapTouch.clientY - lastBackgroundTap.y);
          if (dt <= DOUBLE_TAP_MS && dist <= DOUBLE_TAP_PX) {
            // Second tap close to the first: treat as double-tap → add node.
            lastBackgroundTap = null;
            addNode(undefined, { select: true, rename: true });
            return;
          }
        }
        // First tap (or too far/too slow from previous): record it.
        lastBackgroundTap = { x: tapTouch.clientX, y: tapTouch.clientY, time: now };
      } else {
        // Finger moved — it was a pan, not a tap. Cancel double-tap sequence.
        lastBackgroundTap = null;
      }
    } else if (wasPinch) {
      // A pinch gesture resets double-tap tracking.
      lastBackgroundTap = null;
    }
    return;
  }
  // Lifted one finger during a two-finger pinch: transition to single-finger pan
  // so the remaining finger can continue panning without needing to lift and re-tap.
  if (pinchState && ev.touches.length === 1) {
    pinchState = null;
    panState = {
      startX: ev.touches[0].clientX,
      startY: ev.touches[0].clientY,
      startTx: state.viewport.tx,
      startTy: state.viewport.ty,
    };
  }
});

window.addEventListener('touchcancel', () => {
  // cancelDrag() sets dragState = null and hides the drag SVG.
  cancelDrag();
  panState = null;
  pinchState = null;
});

graphPane.addEventListener('click', (ev) => {
  // Ignore clicks that originated on a node/edge (those stopPropagation already).
  if (isGraphElementTarget(ev.target)) return;
  if (suppressNextBackgroundClick) {
    suppressNextBackgroundClick = false;
    return;
  }
  if (renameSession) commitRenameAndFocusGraph();
  clearSelection();
  graphPane.focus({ preventScroll: true });
});

graphPane.addEventListener('dblclick', (ev) => {
  if (isGraphElementTarget(ev.target)) return;
  addNode(undefined, { select: true, rename: true });
});

renameInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    cancelRenameEditor();
    graphPane.focus({ preventScroll: true });
  }
});

renameDialog.addEventListener('submit', (ev) => {
  ev.preventDefault();
  commitRenameAndFocusGraph();
});

btnRenameCancel.addEventListener('click', () => {
  cancelRenameEditor();
  graphPane.focus({ preventScroll: true });
});

renameModal.addEventListener('click', (ev) => {
  if (ev.target !== renameModal) return;
  cancelRenameEditor();
  graphPane.focus({ preventScroll: true });
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
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && hasSelection()) {
    ev.preventDefault();
    deleteSelection();
    return;
  }
  const single = getSingleSelection();
  // Tab (and Enter on a selected node): create a connected node and enter
  // rename mode (one undo step). Shift+Tab reverses edge direction.
  // addNode with rename:true sets compositeAction=true so addEdge below
  // skips its own pushSnapshot — the whole sequence is one undo entry.
  if (
    ae === graphPane &&
    single?.type === 'node' &&
    (ev.key === 'Tab' || ev.key === 'Enter')
  ) {
    ev.preventDefault();
    const fromId = single.key;
    const newId = addNode(undefined, { select: true, rename: true });
    if (ev.key === 'Tab' && ev.shiftKey) {
      addEdge(newId, fromId);
    } else {
      addEdge(fromId, newId);
    }
    return;
  }
  if (ev.key === 'F2' && single) {
    ev.preventDefault();
    if (single.type === 'node') renameNode(single.key);
    else renameEdge(single.key);
    return;
  }
  if (ev.key === 'Enter' && single?.type === 'edge') {
    ev.preventDefault();
    renameEdge(single.key);
    return;
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
});

// ---------- Model mutations ----------
function addNode(label, { select = false, rename = false } = {}) {
  pushSnapshot();
  const id = freshNodeId();
  const lbl = label ?? id.toUpperCase();
  state.nodes.push({ id, label: lbl });
  const shouldSelect = select || rename;
  if (shouldSelect) setSingleSelection('node', id);
  if (rename) {
    // Mark a composite transaction: the following addEdge (triggered by
    // finishDragAt after dropping on empty space) and commitRenameEditor
    // both belong to the same undo step as this addNode, so they skip
    // their own pushSnapshot calls.
    compositeAction = true;
    openRenameEditor('node', id);
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

function selectNode(id, { toggle = false } = {}) {
  if (toggle) toggleSelection('node', id);
  else setSingleSelection('node', id);
  render();
  graphPane.focus({ preventScroll: true });
}

function selectEdge(key, { toggle = false } = {}) {
  if (toggle) toggleSelection('edge', key);
  else setSingleSelection('edge', key);
  render();
  graphPane.focus({ preventScroll: true });
}

function clearSelection() {
  if (!hasSelection()) return;
  state.selected.clear();
  render();
}

function deleteSelection() {
  if (!hasSelection()) return;
  pushSnapshot();
  const selectedNodes = new Set();
  const selectedEdges = new Set();
  for (const ref of state.selected) {
    const sel = parseSelectionRef(ref);
    if (!sel) continue;
    if (sel.type === 'node') selectedNodes.add(sel.key);
    else selectedEdges.add(sel.key);
  }
  state.nodes = state.nodes.filter((n) => !selectedNodes.has(n.id));
  state.edges = state.edges.filter((e) => {
    if (selectedNodes.has(e.from) || selectedNodes.has(e.to)) return false;
    return !selectedEdges.has(edgeKey(e));
  });
  state.selected.clear();
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

function setRenameDialogContent(type) {
  const itemLabel = type.charAt(0).toUpperCase() + type.slice(1);
  renameTitle.textContent = `Rename ${itemLabel}`;
  renameLabel.textContent = `${itemLabel} name`;
}

function closeRenameEditor() {
  renameSession = null;
  renameModal.hidden = true;
}

function commitRenameAndFocusGraph() {
  commitRenameEditor();
  graphPane.focus({ preventScroll: true });
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
  setRenameDialogContent(type);
  renameInput.value = initialValue;
  renameModal.hidden = false;
  renameInput.focus({ preventScroll: true });
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
    if (hasSelection()) {
      const nextSelected = new Set();
      for (const ref of state.selected) {
        const sel = parseSelectionRef(ref);
        if (!sel) continue;
        if (sel.type === 'node') {
          if (state.nodes.some((n) => n.id === sel.key)) nextSelected.add(ref);
        } else {
          const [f, t] = sel.key.split('->');
          if (state.edges.some((e) => e.from === f && e.to === t)) nextSelected.add(ref);
        }
      }
      state.selected = nextSelected;
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

// ---------- Local cache (auto-save) ----------
const GRAPH_CACHE_KEY = 'autograph.graph.cache';

const DEFAULT_STATE = {
  name: 'graph',
  nodes: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
  edges: [{ from: 'a', to: 'b', label: '' }],
  nextId: 3,
};

function saveToCache() {
  try {
    const data = {
      name: state.name,
      nodes: state.nodes,
      edges: state.edges,
      nextId: state.nextId,
    };
    window.localStorage.setItem(GRAPH_CACHE_KEY, JSON.stringify(data));
  } catch {
    // ignore quota / disabled storage
  }
}

function loadFromCache() {
  try {
    const raw = window.localStorage.getItem(GRAPH_CACHE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) return false;
    // Validate each node has a string id, and each edge has string from/to.
    if (!data.nodes.every((n) => n && typeof n.id === 'string')) return false;
    if (!data.edges.every((e) => e && typeof e.from === 'string' && typeof e.to === 'string')) return false;
    state.name = typeof data.name === 'string' ? data.name : DEFAULT_STATE.name;
    state.nodes = data.nodes;
    state.edges = data.edges;
    state.nextId = typeof data.nextId === 'number' ? data.nextId : DEFAULT_STATE.nextId;
    return true;
  } catch {
    return false;
  }
}

function clearCache() {
  try {
    window.localStorage.removeItem(GRAPH_CACHE_KEY);
  } catch {
    // ignore
  }
}

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
    state.selected.clear();
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

btnNew.addEventListener('click', () => {
  pushSnapshot();
  state.name = DEFAULT_STATE.name;
  state.nodes = structuredClone(DEFAULT_STATE.nodes);
  state.edges = structuredClone(DEFAULT_STATE.edges);
  state.nextId = DEFAULT_STATE.nextId;
  state.selected.clear();
  dotEl.classList.remove('invalid');
  clearCache();
  needsInitialFit = true;
  render();
});

// ---------- Boot ----------
// state is pre-initialised with DEFAULT_STATE values (see `const state` above).
// loadFromCache() overwrites state fields only on success; on failure the
// default values remain intact so render() always gets a valid state.
loadFromCache();
render();
