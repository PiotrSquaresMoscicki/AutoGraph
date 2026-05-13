import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

test.describe('DOT pane visibility', () => {
  test('toggle button shows and hides the DOT pane', async ({ page }) => {
    await openApp(page);
    const pane = page.locator('#dot-pane');
    const btn = page.locator('#btn-toggle-dot');

    await expect(pane).toBeHidden();
    await btn.click();
    await expect(pane).toBeVisible();
    await expect(btn).toHaveText('Hide DOT');
    await expect(btn).toHaveAttribute('aria-pressed', 'true');

    await btn.click();
    await expect(pane).toBeHidden();
    await expect(btn).toHaveText('Show DOT');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  test('visibility is persisted across reloads via localStorage', async ({ page }) => {
    await openApp(page);
    await page.locator('#btn-toggle-dot').click();
    await expect(page.locator('#dot-pane')).toBeVisible();

    // Verify localStorage was written.
    const stored = await page.evaluate(() =>
      window.localStorage.getItem('autograph.dotPane.visible'));
    expect(stored).toBe('true');

    await page.reload();
    await expect(page.locator('#graph svg g.node')).toHaveCount(2);
    await expect(page.locator('#dot-pane')).toBeVisible();
    await expect(page.locator('#btn-toggle-dot')).toHaveText('Hide DOT');

    // Hide again -> persisted as false.
    await page.locator('#btn-toggle-dot').click();
    const stored2 = await page.evaluate(() =>
      window.localStorage.getItem('autograph.dotPane.visible'));
    expect(stored2).toBe('false');
    await page.reload();
    await expect(page.locator('#graph svg g.node')).toHaveCount(2);
    await expect(page.locator('#dot-pane')).toBeHidden();
  });
});
