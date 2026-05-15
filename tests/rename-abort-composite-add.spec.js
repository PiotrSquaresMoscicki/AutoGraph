import { test, expect } from '@playwright/test';

async function openRenameForNewNode(page) {
  await page.goto('/');
  await page.waitForSelector('#graph svg');
  const dot = page.locator('#dot');
  const initialDot = await dot.inputValue();
  await page.locator('#graph-pane').dblclick();
  await expect(page.locator('#rename-modal')).toBeVisible();
  await expect(dot).not.toHaveValue(initialDot);
  return { dot, initialDot };
}

test('Escape aborts new node creation during rename', async ({ page }) => {
  const { dot, initialDot } = await openRenameForNewNode(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#rename-modal')).toBeHidden();
  await expect(dot).toHaveValue(initialDot);
});

test('Cancel button aborts new node creation during rename', async ({ page }) => {
  const { dot, initialDot } = await openRenameForNewNode(page);
  await page.locator('#rename-cancel').click();
  await expect(page.locator('#rename-modal')).toBeHidden();
  await expect(dot).toHaveValue(initialDot);
});

test('Backdrop click aborts new node creation during rename', async ({ page }) => {
  const { dot, initialDot } = await openRenameForNewNode(page);
  await page.locator('#rename-modal').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('#rename-modal')).toBeHidden();
  await expect(dot).toHaveValue(initialDot);
});
