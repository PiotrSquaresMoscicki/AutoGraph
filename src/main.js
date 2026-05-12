import './style.css';
import { instance as vizInstance } from '@viz-js/viz';
import { serialize, parse } from './dot.js';

// ---------- Layout ----------
document.querySelector('#app').innerHTML = `
  <header>
    <h1>AutoGraph</h1>
    <span class="hint">
      double-click empty space: new node &middot;
      drag from a node: connect (and create) &middot;
      double-click node/edge: rename &middot;
      click: select &middot;
      Delete: remove
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
const dotEl = document.querySelector('#dot');
const statusEl = document.querySelector('#status');
const dragLine = document.querySelector('#drag-line line');
const dragSvg = document.querySelector('#drag-line');
dragSvg.style.display = 'none';

let viz = null;
let renderToken = 0;
let suppressDotSync = false;

// ---------- Helpers ----------
function freshNodeId() {
  while (state.nodes.some((n) => n.id === `n${state.nextId}`)) state.nextId++;
  return `n${state.nextId++}`;
}

function edgeKey(e) { return `${e.from}->${e.to}`; }

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

function attachGraphInteractions(svgEl) {
  // Node interactions
  for (const g of svgEl.querySelectorAll('g.node')) {
    const id = getTitle(g);

    g.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      const rect = graphPane.getBoundingClientRect();
      dragState = {
        fromId: id,
        startX: ev.clientX - rect.left,
        startY: ev.clientY - rect.top,
        moved: false,
      };
      dragLine.setAttribute('x1', dragState.startX);
      dragLine.setAttribute('y1', dragState.startY);
      dragLine.setAttribute('x2', dragState.startX);
      dragLine.setAttribute('y2', dragState.startY);
    });

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
  const rect = graphPane.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const dx = x - dragState.startX;
  const dy = y - dragState.startY;
  if (!dragState.moved && Math.hypot(dx, dy) > 4) {
    dragState.moved = true;
    dragSvg.style.display = 'block';
  }
  dragLine.setAttribute('x2', x);
  dragLine.setAttribute('y2', y);
});

window.addEventListener('mouseup', (ev) => {
  if (!dragState) return;
  const ds = dragState;
  dragState = null;
  dragSvg.style.display = 'none';
  if (!ds.moved) return;

  // Determine target: was the mouseup over a node?
  const targetEl = document.elementFromPoint(ev.clientX, ev.clientY);
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
    ev.clientX >= paneRect.left && ev.clientX <= paneRect.right &&
    ev.clientY >= paneRect.top && ev.clientY <= paneRect.bottom
  ) {
    const newId = addNode();
    addEdge(ds.fromId, newId);
  }
});

graphPane.addEventListener('click', (ev) => {
  // Ignore clicks that originated on a node/edge (those stopPropagation already).
  if (ev.target.closest('g.node, g.edge')) return;
  clearSelection();
});

graphPane.addEventListener('dblclick', (ev) => {
  if (ev.target.closest('g.node, g.edge')) return;
  addNode();
});

// Keyboard: delete selection.
window.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
  // Don't hijack edits in the DOT textarea or rename prompts.
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return;
  if (!state.selected) return;
  ev.preventDefault();
  deleteSelection();
});

// ---------- Model mutations ----------
function addNode(label) {
  const id = freshNodeId();
  const lbl = label ?? id.toUpperCase();
  state.nodes.push({ id, label: lbl });
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
  const node = state.nodes.find((n) => n.id === id);
  if (!node) return;
  const next = window.prompt('Rename node label:', node.label);
  if (next == null) return;
  node.label = next;
  render();
}

function renameEdge(key) {
  const [from, to] = key.split('->');
  const edge = state.edges.find((e) => e.from === from && e.to === to);
  if (!edge) return;
  const next = window.prompt('Edge label:', edge.label ?? '');
  if (next == null) return;
  edge.label = next;
  render();
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

// ---------- Boot ----------
render();
