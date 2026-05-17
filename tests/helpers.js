// Shared helpers for AutoGraph Playwright UI tests.
import { expect } from '@playwright/test';

// Keep the synthetic hold just above the production 500 ms threshold so the
// test is fast while still reliably triggering the long-press behavior.
const LONG_PRESS_TEST_HOLD_MS = 520;

/**
 * Open the app with a clean localStorage and wait until the initial render
 * has emitted the default graph SVG.
 *
 * Every call to openApp resets the session sentinel so that localStorage is
 * wiped on the upcoming navigation, giving a guaranteed default-graph slate
 * even when openApp is called multiple times within the same test (e.g. after
 * graph edits have been auto-saved to the cache).
 *
 * Raw page.reload() calls (used in persistence tests) do NOT reset the
 * sentinel, so they see the saved cache and restore the graph as expected.
 */
export async function openApp(page) {
  // Remove the sentinel from the current page's sessionStorage before navigating.
  // This makes the initScript below treat the upcoming page.goto as "first load"
  // and wipe localStorage.  On the very first call the page is about:blank and
  // sessionStorage may be inaccessible — the .catch() handles that silently.
  await page.evaluate(() => {
    try { window.sessionStorage.removeItem('__autograph_test_cleared'); } catch { /* ignore */ }
  }).catch(() => {});

  // Wipe all persisted state on every openApp navigation (sentinel was just cleared).
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('__autograph_test_cleared')) {
      try { window.localStorage.clear(); } catch { /* ignore */ }
      try { window.sessionStorage.setItem('__autograph_test_cleared', '1'); } catch { /* ignore */ }
    }
  });
  await page.goto('/');
  await expect(page.locator('#graph svg g.node')).toHaveCount(2);
  await expect(page.locator('#graph svg g.edge')).toHaveCount(1);
  // The status line is set at the end of the render transition, after
  // attachGraphInteractions has wired click/dblclick listeners. Waiting for it
  // guarantees subsequent clicks land on a fully-interactive graph.
  await expect(page.locator('#status')).toHaveText(/\d+ node\(s\), \d+ edge\(s\)/);
  // Make sure the rename modal isn't already open.
  await expect(page.locator('#rename-modal')).toBeHidden();
}

/** Open the DOT pane (which is hidden by default) so the textarea is usable. */
export async function showDotPane(page) {
  const pane = page.locator('#dot-pane');
  if (await pane.isHidden()) {
    await page.locator('#btn-toggle-dot').click();
  }
  await expect(pane).toBeVisible();
}

/** Locator for a node group whose <title> matches the given id. */
export function nodeLocator(page, id) {
  return page.locator('#graph svg g.node', {
    has: page.locator(`title:text-is("${id}")`),
  });
}

/**
 * "Click" the node with the given id. Dispatches the click event directly on
 * the node group, which is the most reliable approach for tests because
 * d3-graphviz overlays (edge hit-areas, etc.) can otherwise intercept pointer
 * events and Playwright's actionability checks. The node group is what carries
 * the click/dblclick handlers in the application code.
 */
export async function clickNode(page, id, { dblclick = false } = {}) {
  await page.evaluate(
    ({ id, dblclick }) => {
      const titles = document.querySelectorAll('#graph svg g.node > title');
      const titleEl = Array.from(titles).find((t) => t.textContent === id);
      if (!titleEl) throw new Error(`node ${id} not found`);
      const g = titleEl.parentNode;
      const init = { bubbles: true, cancelable: true, button: 0, view: window };
      // Mirror the real interaction order: mousedown -> mouseup -> click [-> dblclick].
      g.dispatchEvent(new MouseEvent('mousedown', init));
      g.dispatchEvent(new MouseEvent('mouseup', init));
      g.dispatchEvent(new MouseEvent('click', init));
      if (dblclick) {
        g.dispatchEvent(new MouseEvent('mousedown', init));
        g.dispatchEvent(new MouseEvent('mouseup', init));
        g.dispatchEvent(new MouseEvent('click', init));
        g.dispatchEvent(new MouseEvent('dblclick', init));
      }
    },
    { id, dblclick },
  );
}

/** Press and hold a node long enough to trigger the node context menu. */
export async function pressAndHoldNode(page, id, { holdMs = LONG_PRESS_TEST_HOLD_MS } = {}) {
  await page.evaluate(
    async ({ id, holdMs }) => {
      const titles = document.querySelectorAll('#graph svg g.node > title');
      const titleEl = Array.from(titles).find((t) => t.textContent === id);
      if (!titleEl) throw new Error(`node ${id} not found`);
      const g = titleEl.parentNode;
      const rect = g.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      const init = {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX,
        clientY,
        view: window,
      };
      g.dispatchEvent(new MouseEvent('mousedown', init));
      await new Promise((resolve) => window.setTimeout(resolve, holdMs));
      g.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      g.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
    },
    { id, holdMs },
  );
}

/** Real pointer long-press on a node using Playwright mouse events. */
export async function mousePressAndHoldNode(page, id, { holdMs = LONG_PRESS_TEST_HOLD_MS } = {}) {
  const box = await nodeLocator(page, id).boundingBox();
  if (!box) throw new Error(`node ${id} has no bounding box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await expect(page.locator('#context-menu')).toBeVisible();
  await page.mouse.up();
}

/** Locator for an edge group whose <title> matches "from->to". */
export function edgeLocator(page, from, to) {
  return page.locator('#graph svg g.edge', {
    has: page.locator(`title:text-is("${from}->${to}")`),
  });
}

/** Click somewhere in the graph pane background that is not on a node/edge. */
export async function clickGraphBackground(page, x = 30, y = 30) {
  const pane = page.locator('#graph-pane');
  const box = await pane.boundingBox();
  await page.mouse.click(box.x + x, box.y + y);
}

/** Double-click somewhere in the graph pane background. */
export async function dblClickGraphBackground(page, x = 50, y = 50) {
  const pane = page.locator('#graph-pane');
  const box = await pane.boundingBox();
  await page.mouse.dblclick(box.x + x, box.y + y);
}

/** Read the visible text of all node labels currently rendered. */
export async function renderedNodeLabels(page) {
  return await page.locator('#graph svg g.node text').allTextContents();
}

/** Wait until the rendered node count matches the expected value. */
export async function expectNodeCount(page, count) {
  await expect(page.locator('#graph svg g.node')).toHaveCount(count);
}

/** Wait until the rendered edge count matches the expected value. */
export async function expectEdgeCount(page, count) {
  await expect(page.locator('#graph svg g.edge')).toHaveCount(count);
}

/** Confirm and submit the rename modal with the given text (empty == unchanged behavior). */
export async function fillRenameDialog(page, text) {
  const modal = page.locator('#rename-modal');
  await expect(modal).toBeVisible();
  const input = page.locator('#rename-input');
  await input.fill(text);
  await input.press('Enter');
  await expect(modal).toBeHidden();
}

/** Cancel the rename modal via Escape. */
export async function cancelRenameDialog(page) {
  const modal = page.locator('#rename-modal');
  await expect(modal).toBeVisible();
  await page.locator('#rename-input').press('Escape');
  await expect(modal).toBeHidden();
}

/**
 * Simulate dragging from the center of a node (by id) to an empty area of the
 * graph pane, triggering the drag-to-create flow. Events are dispatched via
 * page.evaluate so coordinates are taken from the live DOM and are consistent
 * with what document.elementFromPoint sees in finishDragAt.
 *
 * NOTE: JS-dispatched events do NOT cause the browser to synthesise a `click`
 * after mouseup. The regression test for the `suppressNextBackgroundClick` fix
 * therefore explicitly dispatches a click on graphPane (via page.evaluate) after
 * calling this helper to verify that click is suppressed.
 */
export async function dragFromNodeToEmpty(page, nodeId) {
  await page.evaluate((nodeId) => {
    const titleEl = Array.from(
      document.querySelectorAll('#graph svg g.node > title'),
    ).find((t) => t.textContent === nodeId);
    if (!titleEl) throw new Error(`node "${nodeId}" not found`);
    const nodeRect = titleEl.parentNode.getBoundingClientRect();
    const cx = nodeRect.left + nodeRect.width / 2;
    const cy = nodeRect.top + nodeRect.height / 2;
    // Pick the first pane corner (30 px inset) that is not over any node.
    const pane = document.querySelector('#graph-pane');
    const pr = pane.getBoundingClientRect();
    const allNodes = Array.from(document.querySelectorAll('#graph svg g.node'));
    const candidates = [
      [pr.right - 30, pr.top + 30],    // top-right
      [pr.left + 30, pr.bottom - 30],  // bottom-left
      [pr.left + 30, pr.top + 30],     // top-left
      [pr.right - 30, pr.bottom - 30], // bottom-right
    ];
    let tx = candidates[0][0]; let ty = candidates[0][1];
    for (const [x, y] of candidates) {
      const hit = allNodes.some((g) => {
        const r = g.getBoundingClientRect();
        return x >= r.left - 15 && x <= r.right + 15 && y >= r.top - 15 && y <= r.bottom + 15;
      });
      if (!hit) { tx = x; ty = y; break; }
    }
    // Start drag from the node element.
    titleEl.parentNode.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      clientX: cx, clientY: cy, view: window,
    }));
    // mousemove events must go to graphPane (that is where the drag handler lives).
    for (let i = 1; i <= 5; i++) {
      pane.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true,
        clientX: cx + (tx - cx) * i / 5,
        clientY: cy + (ty - cy) * i / 5,
      }));
    }
    // End drag on window (matches the production mouseup listener).
    window.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, clientX: tx, clientY: ty,
    }));
  }, nodeId);
}

/**
 * Simulate dragging from one node to another, triggering the drag-to-connect
 * (edge creation) flow. Uses JS-dispatched events via page.evaluate so that
 * element targeting is based on the live DOM and is reliable regardless of
 * SVG coordinate transforms.
 *
 * The helper searches the target node's bounding box for a hit point that
 * elementFromPoint resolves to the correct node — necessary because edge
 * arrowheads (g.edge polygons) can overlap node centers and would otherwise
 * be returned instead of the node itself.
 */
export async function dragFromNodeToNode(page, fromId, toId) {
  await page.evaluate(({ fromId, toId }) => {
    const getNode = (id) => {
      const titleEl = Array.from(
        document.querySelectorAll('#graph svg g.node > title'),
      ).find((t) => t.textContent === id);
      if (!titleEl) throw new Error(`node "${id}" not found`);
      return titleEl.parentNode;
    };
    const fromG = getNode(fromId);
    const toG = getNode(toId);
    const fromR = fromG.getBoundingClientRect();
    const toR = toG.getBoundingClientRect();
    const fx = fromR.left + fromR.width / 2;
    const fy = fromR.top + fromR.height / 2;
    const tx = toR.left + toR.width / 2;

    // Search the target node's bounding box for a hit point where
    // elementFromPoint correctly resolves to the target node. Edge arrowhead
    // polygons can overlap the node center and would return a g.edge instead.
    const testOffsets = [0, 0.3, -0.3, 0.45, -0.45]; // fractions of half-height
    let goodTy = toR.top + toR.height / 2;
    for (const frac of testOffsets) {
      const testY = toR.top + toR.height * (0.5 + frac);
      const el = document.elementFromPoint(tx, testY);
      if (el?.closest('g.node')?.querySelector('title')?.textContent === toId) {
        goodTy = testY;
        break;
      }
    }

    const pane = document.querySelector('#graph-pane');
    // Start drag from the source node element.
    fromG.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      clientX: fx, clientY: fy, view: window,
    }));
    // mousemove events on graphPane to trigger updateDragTo and set dragState.moved.
    for (let i = 1; i <= 5; i++) {
      pane.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true,
        clientX: fx + (tx - fx) * i / 5,
        clientY: fy + (goodTy - fy) * i / 5,
      }));
    }
    // End drag on window at the valid hit point on the target node.
    window.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, clientX: tx, clientY: goodTy,
    }));
  }, { fromId, toId });
}
