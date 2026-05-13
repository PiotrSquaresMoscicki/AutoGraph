import { test, expect } from '@playwright/test';
import {
  openApp,
  nodeLocator,
  clickNode,
  expectNodeCount,
  expectEdgeCount,
  fillRenameDialog,
} from './helpers.js';

test.describe('viewport and history', () => {
  test('Fit button does not throw and keeps the SVG sized to the pane', async ({ page }) => {
    await openApp(page);
    await page.locator('#btn-fit').click();
    // Viewport should have a valid viewBox after fit.
    const viewBox = await page.locator('#graph svg').getAttribute('viewBox');
    expect(viewBox).toMatch(/^-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?$/);
  });

  test('keyboard +, -, 0 change the viewport scale', async ({ page }) => {
    await openApp(page);
    const pane = page.locator('#graph-pane');
    await pane.focus();

    const readVB = async () => {
      const vb = await page.locator('#graph svg').getAttribute('viewBox');
      const [, , w] = vb.split(/\s+/).map(Number);
      return w;
    };

    // Start from 1:1 (the default fit-content can leave us at max zoom for the
    // tiny default graph, which would clamp `+` to a no-op).
    await page.keyboard.press('0');
    const baseW = await readVB();
    const paneRect = await pane.boundingBox();
    expect(Math.abs(baseW - paneRect.width)).toBeLessThan(1);

    await page.keyboard.press('-');
    const zoomedOutW = await readVB();
    expect(zoomedOutW).toBeGreaterThan(baseW); // zooming out grows viewBox width

    await page.keyboard.press('=');
    await page.keyboard.press('=');
    const zoomedInW = await readVB();
    expect(zoomedInW).toBeLessThan(zoomedOutW);

    await page.keyboard.press('0');
    const resetW = await readVB();
    expect(Math.abs(resetW - paneRect.width)).toBeLessThan(1);
  });

  test('Ctrl+Z undoes a node addition and Ctrl+Y redoes it', async ({ page }) => {
    await openApp(page);
    // Add a node via Enter on selected 'a'.
    await clickNode(page, 'a');
    await page.keyboard.press('Enter');
    await fillRenameDialog(page, 'Extra');
    await expectNodeCount(page, 3);
    await expectEdgeCount(page, 2);

    // Undo the whole composite (node + edge + rename) in one step.
    await page.keyboard.press('Control+z');
    await expectNodeCount(page, 2);
    await expectEdgeCount(page, 1);
    await expect(page.locator('#graph svg g.node text', { hasText: 'Extra' })).toHaveCount(0);

    // Redo.
    await page.keyboard.press('Control+y');
    await expectNodeCount(page, 3);
    await expectEdgeCount(page, 2);
    await expect(page.locator('#graph svg g.node text', { hasText: 'Extra' })).toHaveCount(1);
  });

  test('Ctrl+Shift+Z is an alternate redo shortcut', async ({ page }) => {
    await openApp(page);
    await clickNode(page, 'a');
    await page.keyboard.press('Delete');
    await expectNodeCount(page, 1);
    await page.keyboard.press('Control+z');
    await expectNodeCount(page, 2);
    await page.keyboard.press('Control+Shift+Z');
    await expectNodeCount(page, 1);
  });
});
