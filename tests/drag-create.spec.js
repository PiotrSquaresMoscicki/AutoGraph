import { test, expect } from '@playwright/test';
import {
  openApp,
  nodeLocator,
  edgeLocator,
  dragFromNodeToEmpty,
  dragFromNodeToNode,
  fillRenameDialog,
  cancelRenameDialog,
  expectNodeCount,
  expectEdgeCount,
} from './helpers.js';

test.describe('drag from node to empty space (drag-to-create)', () => {
  test('opens the rename modal', async ({ page }) => {
    await openApp(page);
    await dragFromNodeToEmpty(page, 'a');
    await expect(page.locator('#rename-modal')).toBeVisible();
  });

  test('rename modal stays open when a background click immediately follows drag-to-create (regression)', async ({ page }) => {
    // Regression test for the bug where the background click fired after mouseup
    // immediately called commitRenameAndFocusGraph() and closed the rename modal.
    //
    // In production, the browser determines the click target BEFORE the modal
    // appears (the modal is shown synchronously inside the mouseup handler), so
    // the click is dispatched to graphPane, not to #rename-modal. We replicate
    // that by dispatching a click directly on graphPane after the drag so that
    // suppressNextBackgroundClick (set by finishDragAt) is what prevents the
    // modal from closing — exactly as it does in the real interaction.
    await openApp(page);
    await dragFromNodeToEmpty(page, 'a');
    await expect(page.locator('#rename-modal')).toBeVisible();
    // Dispatch the spurious click directly on graphPane (bypasses the modal
    // overlay, matching the real browser behavior described above).
    await page.evaluate(() => {
      const pane = document.querySelector('#graph-pane');
      const pr = pane.getBoundingClientRect();
      pane.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, view: window,
        clientX: pr.left + 100, clientY: pr.top + 100,
      }));
    });
    await expect(page.locator('#rename-modal')).toBeVisible();
  });

  test('filling the dialog creates the new node and a connecting edge', async ({ page }) => {
    await openApp(page);
    await dragFromNodeToEmpty(page, 'a');
    await fillRenameDialog(page, 'Child');
    await expectNodeCount(page, 3);
    await expectEdgeCount(page, 2);
    await expect(page.locator('#graph svg g.node text', { hasText: 'Child' })).toHaveCount(1);
    // The edge must go from the dragged-from node to the new node.
    const newId = await page.evaluate(() => {
      const titles = Array.from(document.querySelectorAll('#graph svg g.node title'))
        .map((t) => t.textContent);
      return titles.find((id) => id !== 'a' && id !== 'b');
    });
    expect(newId).toBeTruthy();
    await expect(edgeLocator(page, 'a', newId)).toHaveCount(1);
  });

  test('canceling the dialog keeps the new node with its default label', async ({ page }) => {
    await openApp(page);
    await dragFromNodeToEmpty(page, 'b');
    await expect(page.locator('#rename-modal')).toBeVisible();
    const defaultLabel = await page.locator('#rename-input').inputValue();
    await cancelRenameDialog(page);
    await expectNodeCount(page, 3);
    await expect(page.locator('#graph svg g.node text', { hasText: defaultLabel })).toHaveCount(1);
    // An edge from the dragged-from node to the new node must exist.
    const newId = await page.evaluate(() => {
      const titles = Array.from(document.querySelectorAll('#graph svg g.node title'))
        .map((t) => t.textContent);
      return titles.find((id) => id !== 'a' && id !== 'b');
    });
    expect(newId).toBeTruthy();
    await expect(edgeLocator(page, 'b', newId)).toHaveCount(1);
  });
});

test.describe('drag from node to another node (drag-to-connect)', () => {
  test('creates a directed edge between the two nodes', async ({ page }) => {
    await openApp(page);
    // The default graph has a->b. Dragging b->a creates the reverse edge.
    await dragFromNodeToNode(page, 'b', 'a');
    await expectEdgeCount(page, 2);
    await expect(edgeLocator(page, 'b', 'a')).toHaveCount(1);
    // No rename modal should open.
    await expect(page.locator('#rename-modal')).toBeHidden();
  });

  test('dragging a node to itself does not create a self-loop', async ({ page }) => {
    await openApp(page);
    await dragFromNodeToNode(page, 'a', 'a');
    await expectEdgeCount(page, 1);
    await expect(page.locator('#rename-modal')).toBeHidden();
  });

  test('dragging between already-connected nodes does not duplicate the edge', async ({ page }) => {
    await openApp(page);
    // a->b already exists.
    await dragFromNodeToNode(page, 'a', 'b');
    await expectEdgeCount(page, 1);
    await expect(page.locator('#rename-modal')).toBeHidden();
  });
});
