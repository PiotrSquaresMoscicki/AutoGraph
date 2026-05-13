import { test, expect } from '@playwright/test';
import { openApp, showDotPane } from './helpers.js';

test.describe('initial render', () => {
  test('shows header with action buttons', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('h1')).toHaveText('AutoGraph');
    await expect(page.locator('#btn-save')).toBeVisible();
    await expect(page.locator('#btn-load')).toBeVisible();
    await expect(page.locator('#btn-fit')).toBeVisible();
    await expect(page.locator('#btn-toggle-dot')).toBeVisible();
  });

  test('renders the default two-node A -> B graph', async ({ page }) => {
    await openApp(page);
    const titles = await page.locator('#graph svg g.node title').allTextContents();
    expect(titles.sort()).toEqual(['a', 'b']);
    const labels = await page.locator('#graph svg g.node text').allTextContents();
    expect(labels.sort()).toEqual(['A', 'B']);
    await expect(page.locator('#graph svg g.edge title')).toHaveText('a->b');
  });

  test('DOT pane is hidden by default and the toggle button reflects state', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#dot-pane')).toBeHidden();
    const toggle = page.locator('#btn-toggle-dot');
    await expect(toggle).toHaveText('Show DOT');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  test('the initial DOT source matches the default graph', async ({ page }) => {
    await openApp(page);
    await showDotPane(page);
    const dot = await page.locator('#dot').inputValue();
    expect(dot).toContain('digraph G {');
    expect(dot).toContain('a [label="A"];');
    expect(dot).toContain('b [label="B"];');
    expect(dot).toContain('a -> b;');
  });

  test('status bar reports node and edge counts', async ({ page }) => {
    await openApp(page);
    await showDotPane(page);
    await expect(page.locator('#status')).toHaveText(/2 node\(s\), 1 edge\(s\)/);
  });
});
