import { test, expect } from '@playwright/test';
import {
  openApp,
  showDotPane,
  clickNode,
  expectNodeCount,
  expectEdgeCount,
} from './helpers.js';

test.describe('DOT two-way sync', () => {
  test('editing the DOT textarea updates the rendered graph', async ({ page }) => {
    await openApp(page);
    await showDotPane(page);
    const dot = page.locator('#dot');

    await dot.fill('digraph G {\n  x [label="X"];\n  y [label="Y"];\n  z [label="Z"];\n  x -> y;\n  y -> z;\n}\n');

    await expectNodeCount(page, 3);
    await expectEdgeCount(page, 2);
    const labels = await page.locator('#graph svg g.node text').allTextContents();
    expect(labels.sort()).toEqual(['X', 'Y', 'Z']);
    await expect(page.locator('#status')).toHaveText(/3 node\(s\), 2 edge\(s\)/);
    await expect(dot).not.toHaveClass(/invalid/);
  });

  test('invalid DOT is reported and leaves the textarea marked invalid', async ({ page }) => {
    await openApp(page);
    await showDotPane(page);
    const dot = page.locator('#dot');
    await dot.fill('not a valid dot file');
    await expect(dot).toHaveClass(/invalid/);
    await expect(page.locator('#status')).toHaveClass(/error/);
  });

  test('graph edits update the DOT source text', async ({ page }) => {
    await openApp(page);
    await showDotPane(page);
    await clickNode(page, 'a');
    await page.keyboard.press('F2');
    await page.locator('#rename-input').fill('Alpha');
    await page.locator('#rename-input').press('Enter');
    await expect(page.locator('#rename-modal')).toBeHidden();
    const dot = await page.locator('#dot').inputValue();
    expect(dot).toContain('a [label="Alpha"];');
  });
});
