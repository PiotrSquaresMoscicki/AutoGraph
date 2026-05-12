// zoom.js — Custom d3-zoom behavior.
//
// Behavior spec:
//   • Plain mouse wheel / trackpad scroll → vertical pan (and horizontal pan
//     when the wheel event reports horizontal delta).
//   • Shift + wheel → horizontal pan.
//   • Ctrl / Meta + wheel → zoom (also triggered by pinch on touchpads which
//     the browser surfaces as ctrlKey wheel events).
//   • Pinch-to-zoom on touch devices (two-finger gesture) → zoom (d3-zoom
//     handles this via touchstart/touchmove when allowed by the filter).
//   • One-finger touch → pan (handled by d3-zoom drag).
//   • Buttons other than primary are ignored.

import * as d3 from 'd3';

export function createZoom({ onZoom, scaleExtent = [0.1, 10] } = {}) {
  const zoom = d3
    .zoom()
    .scaleExtent(scaleExtent)
    // Decide which events d3-zoom should consume. We accept wheel events
    // unconditionally (we re-interpret them in the handler) and accept touch
    // / mouse drags except for secondary buttons.
    .filter((event) => {
      if (event.type === 'wheel') return true;
      if (event.type === 'mousedown') {
        // Only primary button for drag-pan; right/middle clicks are reserved
        // for the OS / our own UI.
        return event.button === 0;
      }
      if (event.type === 'dblclick') return false; // we use dblclick for "add node"
      return true;
    })
    // Override the wheel→delta function so plain wheel pans and ctrl-wheel
    // zooms (pinch gestures arrive as ctrlKey wheel events).
    .wheelDelta((event) => {
      // d3 default: -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002)
      // We only get called when the event should produce a zoom *amount*; we
      // also handle zoom toggling inside our own wheel listener below.
      const mult =
        event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002;
      return -event.deltaY * mult;
    });

  if (onZoom) zoom.on('zoom', onZoom);
  return zoom;
}

/**
 * Attach the custom wheel pan behavior to the container. d3-zoom by itself
 * would zoom on every wheel event; we want pan unless ctrl/meta is held.
 * The handler dispatches the appropriate zoom transform manually for panning,
 * letting d3-zoom handle zooming via its own wheel pipeline for ctrl-wheel.
 *
 * Returns a teardown function.
 */
export function attachWheelPan(selection, zoom, { panSpeed = 1 } = {}) {
  function onWheel(event) {
    // Pinch on Mac trackpads arrives with ctrlKey synthesized -> let d3 zoom.
    if (event.ctrlKey || event.metaKey) {
      // Let d3-zoom handle the zoom via its installed listener; do not
      // preventDefault here because d3-zoom's own handler will.
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    // Determine delta in pixels.
    const scale =
      event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    let dx = -event.deltaX * scale * panSpeed;
    let dy = -event.deltaY * scale * panSpeed;
    // Shift+wheel maps vertical scroll to horizontal panning. We also keep
    // the natural horizontal delta if the device reports one.
    if (event.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    selection.call(zoom.translateBy, dx, dy);
  }

  const node = selection.node();
  node.addEventListener('wheel', onWheel, { passive: false });
  return () => node.removeEventListener('wheel', onWheel);
}
