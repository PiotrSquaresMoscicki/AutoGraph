// graph.js — Render the DOT source with d3-graphviz and wire up canvas
// interactions (selection, drag-to-create, double-tap edits, etc.).
//
// We treat the DOT string as the *source of truth* and re-render after every
// mutation. Selection state and the camera (zoom/pan) transform are restored
// across re-renders so the experience feels continuous.

import * as d3 from 'd3';
import { graphviz } from 'd3-graphviz';
import {
  addNode,
  addEdge,
  setNodeLabel,
  setEdgeLabel,
  uniqueNodeId,
  parseDot,
} from './dot.js';
import { createZoom, attachWheelPan } from './zoom.js';

const DBLTAP_MS = 350;

/**
 * Create a graph renderer bound to the given host element.
 *
 * Required callbacks on opts:
 *   getDot()           -> current DOT source
 *   commit(newDot)     -> apply a UI mutation (pushes onto history)
 *   onSelect(id|null)  -> selection changed
 *   showStatus(msg, err?)
 *   editorOverlay      -> HTML input element for label editing
 */
export function createGraph(host, opts) {
  const hostSel = d3.select(host);
  // d3-graphviz renders into hostSel; we'll grab its SVG after each render.
  const gv = graphviz(host, {
    useWorker: false, // simpler dev/build; main thread is fast enough.
    fit: true,
    zoom: false, // we install our own zoom behavior
    fade: false,
    growEnteringEdges: false,
    tweenPaths: false,
    tweenShapes: false,
  });

  let selectedNodeId = null;
  let currentTransform = d3.zoomIdentity;
  let svgSel = null;
  let rootG = null; // <g> that wraps everything we transform
  let zoom = null;
  let detachWheel = null;
  let listenerCleanups = [];
  let lastTapTime = 0;
  let lastTapTarget = null;
  let lastTapX = 0;
  let lastTapY = 0;
  let renderToken = 0;
  let dragState = null;
  let tempEdgeEl = null;
  let isNodeDragging = false; // suppress viewport pan/zoom during node drag

  // ---------- rendering ----------------------------------------------------

  function renderDot(dot) {
    const token = ++renderToken;
    return new Promise((resolve) => {
      gv.onerror((err) => {
        opts.showStatus(`Graphviz error: ${err}`, true);
        resolve();
      });
      gv.renderDot(dot, () => {
        if (token !== renderToken) {
          resolve();
          return;
        }
        afterRender();
        resolve();
      });
    });
  }

  function afterRender() {
    // Tear down any listeners installed in the previous render to prevent
    // duplicate event firing / memory leaks.
    teardownListeners();

    svgSel = hostSel.select('svg');
    if (svgSel.empty()) return;

    // Ensure the SVG fills the host element.
    svgSel
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('preserveAspectRatio', 'xMidYMid meet');

    rootG = svgSel.select('g'); // the <g id="graph0"> root group
    if (rootG.empty()) return;

    // Install our zoom behavior on the SVG with the current transform.
    zoom = createZoom({
      onZoom: (event) => {
        currentTransform = event.transform;
        rootG.attr('transform', event.transform.toString());
        // If the floating label editor is open, keep it positioned correctly.
        repositionLabelEditor();
      },
      shouldFilter: () => !isNodeDragging,
    });
    svgSel.call(zoom);
    svgSel.call(zoom.transform, currentTransform);
    // Disable default dblclick zoom; we use dblclick for "create node".
    svgSel.on('dblclick.zoom', null);

    detachWheel = attachWheelPan(svgSel, zoom, {
      shouldPan: () => !isNodeDragging,
    });

    installInteraction();
    applySelectionHighlight();
  }

  function teardownListeners() {
    if (detachWheel) {
      detachWheel();
      detachWheel = null;
    }
    if (svgSel && !svgSel.empty()) {
      // Remove all our namespaced listeners.
      svgSel.on('.ag', null);
      svgSel.selectAll('.node').on('.ag', null);
    }
    for (const fn of listenerCleanups) fn();
    listenerCleanups = [];
    removeTempEdge();
  }

  // ---------- selection ----------------------------------------------------

  function applySelectionHighlight() {
    if (!svgSel || svgSel.empty()) return;
    svgSel.selectAll('.node').classed('ag-selected', false);
    if (selectedNodeId) {
      svgSel
        .selectAll('.node')
        .filter(function () {
          return getNodeId(this) === selectedNodeId;
        })
        .classed('ag-selected', true);
    }
  }

  function setSelected(id) {
    selectedNodeId = id;
    applySelectionHighlight();
    opts.onSelect(id);
  }

  function getNodeId(el) {
    // d3-graphviz emits <g class="node"><title>id</title>...</g>
    const t = el.querySelector(':scope > title');
    return t ? t.textContent : null;
  }

  function getEdgeEndpoints(el) {
    const t = el.querySelector(':scope > title');
    if (!t) return null;
    // Title is typically "source->target" or "source--target".
    const m = t.textContent.match(/^(.+?)(->|--)(.+)$/);
    if (!m) return null;
    return { source: m[1], target: m[3] };
  }

  function findNodeAt(clientX, clientY) {
    const els = document.elementsFromPoint(clientX, clientY);
    for (const el of els) {
      const g = el.closest && el.closest('.node');
      if (g && svgSel.node().contains(g)) return g;
    }
    return null;
  }

  // ---------- interaction --------------------------------------------------

  function installInteraction() {
    const svgNode = svgSel.node();
    const nodes = svgSel.selectAll('.node');

    // --- Background double-click / double-tap → create a node ---
    svgSel.on('dblclick.ag', (event) => {
      // Ignore dblclicks that land on a node/edge (handled separately).
      if (event.target.closest('.node') || event.target.closest('.edge')) return;
      const pt = svgPointFromEvent(event);
      createNodeAt(pt);
    });

    // Pointer-based double-tap detection for touch devices on empty space.
    svgSel.on('pointerdown.ag', (event) => {
      if (event.pointerType !== 'touch') return;
      if (event.target.closest('.node') || event.target.closest('.edge')) return;
      const now = performance.now();
      if (
        now - lastTapTime < DBLTAP_MS &&
        lastTapTarget === 'bg' &&
        prevTapDistance(event) < 30
      ) {
        const pt = svgPointFromEvent(event);
        createNodeAt(pt);
        lastTapTime = 0;
      } else {
        lastTapTime = now;
        lastTapTarget = 'bg';
        lastTapX = event.clientX;
        lastTapY = event.clientY;
      }
    });

    // --- Edge double-click → edit label ---
    svgSel.selectAll('.edge').on('dblclick.ag', function (event) {
      event.stopPropagation();
      const ends = getEdgeEndpoints(this);
      if (!ends) return;
      openLabelEditor({
        kind: 'edge',
        endpoints: ends,
        el: this,
        currentLabel: extractEdgeLabel(opts.getDot(), ends),
      });
    });

    // --- Node interactions: pointer-down begins potential drag; click on
    //     release without movement selects; double-click opens label editor.
    nodes.each(function () {
      const nodeEl = this;
      const sel = d3.select(nodeEl);

      sel.on('dblclick.ag', (event) => {
        event.stopPropagation();
        const id = getNodeId(nodeEl);
        if (!id) return;
        openLabelEditor({
          kind: 'node',
          id,
          el: nodeEl,
          currentLabel: extractNodeLabel(opts.getDot(), id),
        });
      });

      sel.on('pointerdown.ag', (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        event.stopPropagation();
        const sourceId = getNodeId(nodeEl);
        if (!sourceId) return;
        const startX = event.clientX;
        const startY = event.clientY;

        const pointerId = event.pointerId;
        try {
          nodeEl.setPointerCapture(pointerId);
        } catch (_) {
          /* not supported on all elements */
        }

        let isDragging = false;

        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (!isDragging && Math.hypot(dx, dy) > 6) {
            isDragging = true;
            isNodeDragging = true;
            dragState = {
              sourceId,
              sourceEl: nodeEl,
              currentPt: svgPointFromClient(ev.clientX, ev.clientY),
            };
            showTempEdge();
          }
          if (isDragging) {
            dragState.currentPt = svgPointFromClient(ev.clientX, ev.clientY);
            updateTempEdge();
          }
        };

        const onUp = (ev) => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          isNodeDragging = false;
          try {
            nodeEl.releasePointerCapture(pointerId);
          } catch (_) {
            /* */
          }
          if (!isDragging) {
            // Tap / click: select node.
            setSelected(sourceId);
            // Touch double-tap detection for node label edit.
            if (ev.pointerType === 'touch') {
              const now = performance.now();
              if (
                now - lastTapTime < DBLTAP_MS &&
                lastTapTarget === sourceId
              ) {
                openLabelEditor({
                  kind: 'node',
                  id: sourceId,
                  el: nodeEl,
                  currentLabel: extractNodeLabel(opts.getDot(), sourceId),
                });
                lastTapTime = 0;
              } else {
                lastTapTime = now;
                lastTapTarget = sourceId;
              }
            }
            return;
          }
          // Drag ended: figure out where.
          removeTempEdge();
          const tgtEl = findNodeAt(ev.clientX, ev.clientY);
          if (tgtEl && tgtEl !== nodeEl) {
            const targetId = getNodeId(tgtEl);
            if (targetId) {
              opts.commit(addEdge(opts.getDot(), sourceId, targetId));
            }
          } else {
            // Drop on empty space → new node + edge.
            const dot = opts.getDot();
            const newId = uniqueNodeId(dot, 'n');
            let next = addNode(dot, newId, { label: newId });
            next = addEdge(next, sourceId, newId);
            opts.commit(next);
            // Select the new node so the user can chain operations.
            selectedNodeId = newId;
          }
          dragState = null;
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });
    });

    // Click on background to clear selection.
    svgSel.on('click.ag', (event) => {
      if (event.target.closest('.node') || event.target.closest('.edge')) return;
      setSelected(null);
    });
  }

  // ---------- floating label editor ---------------------------------------

  let activeEditor = null;
  const editorEl = opts.editorOverlay;

  function openLabelEditor({ kind, id, endpoints, el, currentLabel }) {
    closeLabelEditor();
    activeEditor = { kind, id, endpoints, el };
    editorEl.value = currentLabel || '';
    editorEl.classList.add('visible');
    repositionLabelEditor();
    editorEl.focus();
    editorEl.select();

    const commit = () => {
      const val = editorEl.value;
      if (!activeEditor) return;
      const dot = opts.getDot();
      if (activeEditor.kind === 'node') {
        opts.commit(setNodeLabel(dot, activeEditor.id, val));
      } else if (activeEditor.kind === 'edge') {
        opts.commit(
          setEdgeLabel(dot, activeEditor.endpoints.source, activeEditor.endpoints.target, val)
        );
      }
      closeLabelEditor();
    };
    const cancel = () => closeLabelEditor();

    editorEl.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    editorEl.onblur = commit;
  }

  function closeLabelEditor() {
    if (!activeEditor) {
      editorEl.classList.remove('visible');
      return;
    }
    activeEditor = null;
    editorEl.classList.remove('visible');
    editorEl.onkeydown = null;
    editorEl.onblur = null;
  }

  function repositionLabelEditor() {
    if (!activeEditor || !svgSel) return;
    const el = activeEditor.el;
    if (!el || !el.isConnected) {
      closeLabelEditor();
      return;
    }
    const bbox = el.getBoundingClientRect();
    const host = hostSel.node().getBoundingClientRect();
    // Match the rendered text size of the underlying SVG label so the inline
    // editor visually replaces the label seamlessly.
    const textEl = el.querySelector('text');
    if (textEl) {
      const computedStyle = window.getComputedStyle(textEl);
      const fontSize = parseFloat(computedStyle.fontSize);
      if (fontSize && !Number.isNaN(fontSize)) {
        editorEl.style.fontSize = fontSize + 'px';
      }
      if (computedStyle.fontFamily) editorEl.style.fontFamily = computedStyle.fontFamily;
    } else {
      editorEl.style.fontSize = '';
      editorEl.style.fontFamily = '';
    }
    const w = Math.max(80, bbox.width);
    const h = Math.max(28, bbox.height * 0.6);
    editorEl.style.width = w + 'px';
    editorEl.style.height = h + 'px';
    editorEl.style.left = bbox.left - host.left + (bbox.width - w) / 2 + 'px';
    editorEl.style.top = bbox.top - host.top + (bbox.height - h) / 2 + 'px';
  }

  // ---------- helpers ------------------------------------------------------

  function prevTapDistance(event) {
    return Math.hypot(event.clientX - lastTapX, event.clientY - lastTapY);
  }

  function svgPointFromEvent(event) {
    return svgPointFromClient(event.clientX, event.clientY);
  }

  function svgPointFromClient(cx, cy) {
    if (!svgSel) return { x: 0, y: 0 };
    const svg = svgSel.node();
    const pt = svg.createSVGPoint();
    pt.x = cx;
    pt.y = cy;
    const ctm = rootG.node().getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const inv = ctm.inverse();
    const p = pt.matrixTransform(inv);
    return { x: p.x, y: p.y };
  }

  function createNodeAt(/* pt */) {
    // Graphviz auto-layouts so the explicit position is not honored without
    // engine=neato/fdp + pos="x,y!". Adding the node and letting auto-layout
    // place it keeps the "auto-arranging" behavior of the spec.
    const dot = opts.getDot();
    const id = uniqueNodeId(dot, 'n');
    opts.commit(addNode(dot, id, { label: id }));
    selectedNodeId = id;
  }

  function extractNodeLabel(dot, id) {
    const m = parseDot(dot);
    const n = m.nodes.get(id);
    if (!n) return id;
    return n.attrs.label !== undefined && n.attrs.label !== null ? String(n.attrs.label) : id;
  }
  function extractEdgeLabel(dot, ends) {
    const m = parseDot(dot);
    const e = m.edges.find((x) => x.source === ends.source && x.target === ends.target);
    if (!e) return '';
    return e.attrs.label !== undefined && e.attrs.label !== null ? String(e.attrs.label) : '';
  }

  // ---------- temp edge preview during drag --------------------------------

  function showTempEdge() {
    if (!svgSel || !dragState) return;
    if (tempEdgeEl) return;
    tempEdgeEl = rootG.append('line').attr('class', 'ag-temp-edge');
    updateTempEdge();
  }
  function updateTempEdge() {
    if (!tempEdgeEl || !dragState) return;
    const srcBBox = dragState.sourceEl.getBBox();
    const cx = srcBBox.x + srcBBox.width / 2;
    const cy = srcBBox.y + srcBBox.height / 2;
    tempEdgeEl
      .attr('x1', cx)
      .attr('y1', cy)
      .attr('x2', dragState.currentPt.x)
      .attr('y2', dragState.currentPt.y);
  }
  function removeTempEdge() {
    if (tempEdgeEl) {
      tempEdgeEl.remove();
      tempEdgeEl = null;
    }
  }

  // ---------- public API ---------------------------------------------------

  return {
    render: renderDot,
    getSelected: () => selectedNodeId,
    setSelected,
    clearSelection: () => setSelected(null),
    closeLabelEditor,
    destroy: () => {
      teardownListeners();
      ++renderToken; // invalidate pending renders
      try {
        hostSel.selectAll('*').remove();
      } catch (_) {
        /* */
      }
    },
  };
}
