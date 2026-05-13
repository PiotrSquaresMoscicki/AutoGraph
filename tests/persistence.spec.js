import { test, expect } from '@playwright/test';
import {
  openApp,
  dblClickGraphBackground,
  fillRenameDialog,
  expectNodeCount,
  expectEdgeCount,
} from './helpers.js';

const CACHE_KEY = 'autograph.graph.cache';

test.describe('Auto-save (localStorage cache)', () => {
  test('cache entry is written to localStorage after render', async ({ page }) => {
    await openApp(page);
    const raw = await page.evaluate((key) => window.localStorage.getItem(key), CACHE_KEY);
    expect(raw).not.toBeNull();
    const data = JSON.parse(raw);
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.edges)).toBe(true);
    expect(typeof data.name).toBe('string');
    expect(typeof data.nextId).toBe('number');
  });

  test('graph is restored from cache on page reload', async ({ page }) => {
    await openApp(page);
    // Add a node so the graph differs from the default.
    await dblClickGraphBackground(page, 60, 60);
    await fillRenameDialog(page, 'Persisted');
    await expectNodeCount(page, 3);
    await expect(page.locator('#status')).toHaveText(/3 node\(s\)/);

    // Reload — the sessionStorage sentinel prevents openApp's initScript from
    // wiping localStorage, so the app boots from the saved cache.
    await page.reload();
    await expect(page.locator('#status')).toHaveText(/\d+ node\(s\), \d+ edge\(s\)/);
    await expectNodeCount(page, 3);
    await expect(page.locator('#graph svg g.node text', { hasText: 'Persisted' })).toHaveCount(1);
  });

  test('corrupt cache falls back to the default graph', async ({ page }) => {
    await openApp(page);
    // Overwrite the cache with malformed JSON.
    await page.evaluate((key) => {
      window.localStorage.setItem(key, 'not valid json {{{');
    }, CACHE_KEY);
    await page.reload();
    await expect(page.locator('#status')).toHaveText(/2 node\(s\), 1 edge\(s\)/);
    await expectNodeCount(page, 2);
    await expectEdgeCount(page, 1);
  });

  test('cache with invalid node shape falls back to the default graph', async ({ page }) => {
    await openApp(page);
    await page.evaluate((key) => {
      const bad = JSON.stringify({
        name: 'graph',
        nodes: [{ notAnId: 'x' }, { alsoNoId: 'y' }], // missing required `id` field
        edges: [],
        nextId: 3,
      });
      window.localStorage.setItem(key, bad);
    }, CACHE_KEY);
    await page.reload();
    await expect(page.locator('#status')).toHaveText(/2 node\(s\), 1 edge\(s\)/);
    await expectNodeCount(page, 2);
    await expectEdgeCount(page, 1);
  });

  test('cache with invalid edge shape falls back to the default graph', async ({ page }) => {
    await openApp(page);
    await page.evaluate((key) => {
      const bad = JSON.stringify({
        name: 'graph',
        nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        edges: [{ notFrom: 'a', to: 'b' }], // missing required `from` field
        nextId: 3,
      });
      window.localStorage.setItem(key, bad);
    }, CACHE_KEY);
    await page.reload();
    await expect(page.locator('#status')).toHaveText(/2 node\(s\), 1 edge\(s\)/);
    await expectNodeCount(page, 2);
    await expectEdgeCount(page, 1);
  });
});

test.describe('New button', () => {
  test('New button is visible in the header', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#btn-new')).toBeVisible();
    await expect(page.locator('#btn-new')).toHaveText('New');
  });

  test('New button resets the graph to the default two-node state', async ({ page }) => {
    await openApp(page);
    // Modify the graph first.
    await dblClickGraphBackground(page, 80, 80);
    await fillRenameDialog(page, 'Extra');
    await expectNodeCount(page, 3);

    await page.locator('#btn-new').click();
    await expect(page.locator('#status')).toHaveText(/2 node\(s\), 1 edge\(s\)/);
    await expectNodeCount(page, 2);
    await expectEdgeCount(page, 1);
    const titles = await page.locator('#graph svg g.node title').allTextContents();
    expect(titles.sort()).toEqual(['a', 'b']);
  });

  test('New button clears the cache so a reload still shows the default graph', async ({ page }) => {
    await openApp(page);
    // Add a node so the cache has a non-default state.
    await dblClickGraphBackground(page, 60, 60);
    await fillRenameDialog(page, 'WillBeGone');
    await expectNodeCount(page, 3);
    await expect(page.locator('#status')).toHaveText(/3 node\(s\)/);

    // New clears the cache, resets state, and re-renders. Wait for render to
    // complete (status update) so saveToCache has written the default state.
    await page.locator('#btn-new').click();
    await expect(page.locator('#status')).toHaveText(/2 node\(s\), 1 edge\(s\)/);

    // Reload — cache now holds the default graph.
    await page.reload();
    await expect(page.locator('#status')).toHaveText(/2 node\(s\), 1 edge\(s\)/);
    await expectNodeCount(page, 2);
    await expectEdgeCount(page, 1);
  });

  test('New button can be undone with Ctrl+Z', async ({ page }) => {
    await openApp(page);
    await dblClickGraphBackground(page, 80, 80);
    await fillRenameDialog(page, 'BeforeNew');
    await expectNodeCount(page, 3);

    await page.locator('#btn-new').click();
    await expect(page.locator('#status')).toHaveText(/2 node\(s\), 1 edge\(s\)/);

    // Undo should restore the state that existed before New was clicked.
    await page.keyboard.press('Control+z');
    await expect(page.locator('#status')).toHaveText(/3 node\(s\)/);
    await expectNodeCount(page, 3);
    await expect(page.locator('#graph svg g.node text', { hasText: 'BeforeNew' })).toHaveCount(1);
  });
});
