// Shared helpers for AutoGraph Playwright UI tests.
import { expect } from '@playwright/test';

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
