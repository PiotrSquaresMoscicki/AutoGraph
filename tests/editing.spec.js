import { test, expect } from '@playwright/test';
import {
  openApp,
  edgeLocator,
  clickNode,
  pressAndHoldNode,
  mousePressAndHoldNode,
  dblClickGraphBackground,
  clickGraphBackground,
  fillRenameDialog,
  cancelRenameDialog,
  expectNodeCount,
  expectEdgeCount,
} from './helpers.js';

test.describe('node and edge editing', () => {
  test('double-click empty space creates a new node and opens rename', async ({ page }) => {
    await openApp(page);
    await dblClickGraphBackground(page, 60, 60);
    await expect(page.locator('#rename-modal')).toBeVisible();
    await fillRenameDialog(page, 'Hello');
    await expectNodeCount(page, 3);
    await expect(page.locator('#graph svg g.node text', { hasText: 'Hello' })).toHaveCount(1);
  });

  test('cancel rename keeps the new node with the default uppercase label', async ({ page }) => {
    await openApp(page);
    await dblClickGraphBackground(page, 80, 80);
    await expect(page.locator('#rename-modal')).toBeVisible();
    const initial = await page.locator('#rename-input').inputValue();
    expect(initial).toMatch(/^N\d+$/i); // default label is uppercase of id (e.g. N3)
    await cancelRenameDialog(page);
    await expectNodeCount(page, 3);
    await expect(page.locator('#graph svg g.node text', { hasText: initial })).toHaveCount(1);
  });

  test('click selects a node; clicking another moves selection; background click clears it', async ({ page }) => {
    await openApp(page);

    // Click node A and verify selection by pressing Delete -> A is removed.
    await clickNode(page, 'a');
    await page.keyboard.press('Delete');
    await expectNodeCount(page, 1);
    await expect(page.locator('#graph svg g.node title')).toHaveText('b');

    // Reload, then clicking B should move selection to B.
    await openApp(page);
    await clickNode(page, 'a');
    await clickNode(page, 'b');
    await page.keyboard.press('Delete');
    await expectNodeCount(page, 1);
    await expect(page.locator('#graph svg g.node title')).toHaveText('a');

    // Background click clears the selection so Delete does nothing.
    await openApp(page);
    await clickNode(page, 'a');
    await clickGraphBackground(page, 20, 20);
    await page.keyboard.press('Delete');
    await expectNodeCount(page, 2);
    await expectEdgeCount(page, 1);
  });

  test('Delete key removes the selected node and its incident edges', async ({ page }) => {
    await openApp(page);
    await clickNode(page, 'a');
    await page.keyboard.press('Delete');
    await expectNodeCount(page, 1);
    await expectEdgeCount(page, 0);
    await expect(page.locator('#graph svg g.node title')).toHaveText('b');
  });

  test('Backspace also deletes the selection', async ({ page }) => {
    await openApp(page);
    await clickNode(page, 'b');
    await page.keyboard.press('Backspace');
    await expectNodeCount(page, 1);
    await expectEdgeCount(page, 0);
    await expect(page.locator('#graph svg g.node title')).toHaveText('a');
  });

  test('clicking the edge selects it and Delete removes only the edge', async ({ page }) => {
    await openApp(page);
    // Click the edge's visible path; clicks bubble to the edge group handler.
    await edgeLocator(page, 'a', 'b').locator('path').first().click({ force: true });
    await page.keyboard.press('Delete');
    await expectEdgeCount(page, 0);
    await expectNodeCount(page, 2);
  });

  test('F2 renames the selected node', async ({ page }) => {
    await openApp(page);
    await clickNode(page, 'a');
    await page.keyboard.press('F2');
    await fillRenameDialog(page, 'Alpha');
    await expect(page.locator('#graph svg g.node text', { hasText: 'Alpha' })).toHaveCount(1);
    // The other node ('B') is unchanged.
    await expect(page.locator('#graph svg g.node text', { hasText: /^B$/ })).toHaveCount(1);
  });

  test('double-click renames a node', async ({ page }) => {
    await openApp(page);
    await clickNode(page, 'b', { dblclick: true });
    await fillRenameDialog(page, 'Beta');
    await expect(page.locator('#graph svg g.node text', { hasText: 'Beta' })).toHaveCount(1);
  });

  test('press-and-hold on a node opens a context menu with delete', async ({ page }) => {
    await openApp(page);
    await pressAndHoldNode(page, 'a');
    await expect(page.locator('#context-menu')).toBeVisible();
    await expect(page.locator('#context-delete-node')).toBeVisible();
    await page.locator('#context-delete-node').click();
    await expect(page.locator('#context-menu')).toBeHidden();
    await expectNodeCount(page, 1);
    await expectEdgeCount(page, 0);
    await expect(page.locator('#graph svg g.node title')).toHaveText('b');
  });

  test('real mouse press-and-hold keeps the menu open on release and deletes the held node', async ({ page }) => {
    await openApp(page);
    await mousePressAndHoldNode(page, 'a');
    await expect(page.locator('#context-menu')).toBeVisible();
    await page.locator('#context-delete-node').click();
    await expect(page.locator('#context-menu')).toBeHidden();
    await expectNodeCount(page, 1);
    await expectEdgeCount(page, 0);
    await expect(page.locator('#graph svg g.node title')).toHaveText('b');
  });

  test('F2 / Enter renames the selected edge', async ({ page }) => {
    await openApp(page);
    await edgeLocator(page, 'a', 'b').locator('path').first().click({ force: true });
    await page.keyboard.press('F2');
    await fillRenameDialog(page, 'connects');
    await expect(page.locator('#graph svg g.edge text', { hasText: 'connects' })).toHaveCount(1);

    // Enter on a selected edge also opens rename.
    await edgeLocator(page, 'a', 'b').locator('path').first().click({ force: true });
    await page.keyboard.press('Enter');
    await fillRenameDialog(page, 'links');
    await expect(page.locator('#graph svg g.edge text', { hasText: 'links' })).toHaveCount(1);
  });

  test('Enter on a selected node creates a new connected child node and opens rename', async ({ page }) => {
    await openApp(page);
    await clickNode(page, 'a');
    await page.keyboard.press('Enter');
    await expect(page.locator('#rename-modal')).toBeVisible();
    await fillRenameDialog(page, 'Child');
    await expectNodeCount(page, 3);
    await expectEdgeCount(page, 2);
    await expect(page.locator('#graph svg g.node text', { hasText: 'Child' })).toHaveCount(1);

    // New edge goes from selected node (a) to the newly added node.
    const newId = await page.evaluate(() => {
      const titles = Array.from(document.querySelectorAll('#graph svg g.node title'))
        .map((t) => t.textContent);
      return titles.find((id) => id !== 'a' && id !== 'b');
    });
    expect(newId).toBeTruthy();
    await expect(edgeLocator(page, 'a', newId)).toHaveCount(1);
  });

  test('Tab and Shift+Tab create forward/reverse connected children', async ({ page }) => {
    await openApp(page);
    await clickNode(page, 'a');
    await page.keyboard.press('Tab');
    await fillRenameDialog(page, 'Fwd');
    await expectNodeCount(page, 3);

    const fwdId = await page.evaluate(() => {
      const titles = Array.from(document.querySelectorAll('#graph svg g.node title'))
        .map((t) => t.textContent);
      return titles.find((id) => id !== 'a' && id !== 'b');
    });
    await expect(edgeLocator(page, 'a', fwdId)).toHaveCount(1);

    // Now Shift+Tab from the new (selected) node should create a reverse edge.
    await page.keyboard.press('Shift+Tab');
    await fillRenameDialog(page, 'Rev');
    await expectNodeCount(page, 4);

    const revId = await page.evaluate((known) => {
      const titles = Array.from(document.querySelectorAll('#graph svg g.node title'))
        .map((t) => t.textContent);
      return titles.find((id) => !known.includes(id));
    }, ['a', 'b', fwdId]);
    // Reverse: edge goes from the new node back to the previously selected (fwdId).
    await expect(edgeLocator(page, revId, fwdId)).toHaveCount(1);
  });
});
