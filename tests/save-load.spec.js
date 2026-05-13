import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {
  openApp,
  showDotPane,
  expectNodeCount,
  expectEdgeCount,
} from './helpers.js';

test.describe('Save and Load', () => {
  test('Save downloads a .dot file containing the current graph', async ({ page }) => {
    await openApp(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#btn-save').click(),
    ]);
    expect(download.suggestedFilename()).toBe('graph.dot');

    const tmpPath = path.join(os.tmpdir(), `autograph-save-${Date.now()}.dot`);
    await download.saveAs(tmpPath);
    const contents = await fs.readFile(tmpPath, 'utf8');
    await fs.unlink(tmpPath).catch(() => {});

    expect(contents).toContain('digraph G {');
    expect(contents).toContain('a [label="A"];');
    expect(contents).toContain('b [label="B"];');
    expect(contents).toContain('a -> b;');
    await expect(page.locator('#status')).toHaveText(/Saved graph\.dot/);
  });

  test('Load replaces the graph with content from a .dot file', async ({ page }) => {
    await openApp(page);
    const dot = [
      'digraph G {',
      '  one [label="One"];',
      '  two [label="Two"];',
      '  three [label="Three"];',
      '  one -> two;',
      '  two -> three;',
      '  one -> three [label="skip"];',
      '}',
      '',
    ].join('\n');

    await page.locator('#file-input').setInputFiles({
      name: 'mygraph.dot',
      mimeType: 'text/vnd.graphviz',
      buffer: Buffer.from(dot, 'utf8'),
    });

    await expectNodeCount(page, 3);
    await expectEdgeCount(page, 3);
    const labels = await page.locator('#graph svg g.node text').allTextContents();
    expect(labels.sort()).toEqual(['One', 'Three', 'Two']);
    await expect(page.locator('#status')).toHaveText(/Loaded mygraph\.dot/);

    // Subsequent Save uses the loaded file's base name.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#btn-save').click(),
    ]);
    expect(download.suggestedFilename()).toBe('mygraph.dot');
  });

  test('Loading an invalid file shows an error and leaves the graph untouched', async ({ page }) => {
    await openApp(page);
    await showDotPane(page);
    const beforeDot = await page.locator('#dot').inputValue();

    await page.locator('#file-input').setInputFiles({
      name: 'broken.dot',
      mimeType: 'text/vnd.graphviz',
      buffer: Buffer.from('this is not a dot file', 'utf8'),
    });

    await expect(page.locator('#status')).toHaveText(/Failed to load broken\.dot/);
    await expect(page.locator('#status')).toHaveClass(/error/);
    // Graph state is unchanged.
    await expectNodeCount(page, 2);
    await expectEdgeCount(page, 1);
    await expect(page.locator('#dot')).toHaveValue(beforeDot);
  });
});
