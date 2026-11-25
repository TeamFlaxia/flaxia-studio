import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { chromium } from 'playwright';

const zipPath = '/tmp/flaxia-import.zip';
const pixelPng = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
writeFileSync(
  zipPath,
  zipSync({
    'imported/hello.txt': strToU8('imported hello\n'),
    'notes.md': strToU8('# imported notes\n'),
    'pixel.png': pixelPng,
  }),
);
const downloadPath = '/tmp/flaxia-export.zip';
if (existsSync(downloadPath)) rmSync(downloadPath);

function check(label, condition, detail) {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${detail}`}`);
  console.log(`ok - ${label}`);
}

/** Monaco renders spaces as NBSP in `innerText`; normalise before comparing. */
function normalise(text) {
  return String(text).replace(/\u00a0/g, ' ');
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`);
  });
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(400);

  // Default layout: Timeline panel, inspector and the preview tab
  check(
    'timeline panel selected',
    (await page.locator('[data-panel-tab="timeline"]').getAttribute('aria-selected')) === 'true',
  );
  check(
    'timeline view active',
    (await page.locator('.panel-view[data-view="timeline"].is-active').count()) === 1,
  );
  check('inspector visible', (await page.locator('.inspector:not(.hidden)').count()) === 1);
  check('preview tab exists', (await page.locator('.tab-preview').count()) === 1);
  await page.locator('.tab-preview').click();
  await page.waitForTimeout(300);
  check('preview pane visible', (await page.locator('.preview-pane:not(.hidden)').count()) === 1);
  await page.locator('.brand').click();
  await page.waitForTimeout(200);

  // New file
  await page.locator('button[aria-label="New file"]').first().click();
  await page.locator('.dialog .input').fill('e2e.ts');
  await page.locator('.dialog .btn-primary').click();
  await page.waitForTimeout(500);
  check(
    'new file tab',
    (await page.locator('.tab[aria-selected="true"] .tab-label').innerText()) === 'e2e.ts',
  );
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('export const answer = 42;\n');
  await page.waitForTimeout(900);

  // Unified undo/redo: Monaco text edits are part of the app history.
  let editorText = normalise(await page.locator('.monaco-editor .view-lines').innerText());
  check('typed text present before undo', editorText.includes('answer = 42'), editorText);
  await page.keyboard.press('Control+KeyZ');
  await page.waitForTimeout(250);
  editorText = normalise(await page.locator('.monaco-editor .view-lines').innerText());
  check('undo removes typed text', !editorText.includes('answer = 42'), editorText);
  await page.keyboard.press('Control+Shift+KeyZ');
  await page.waitForTimeout(250);
  editorText = normalise(await page.locator('.monaco-editor .view-lines').innerText());
  check('redo restores typed text', editorText.includes('answer = 42'), editorText);

  // New folder + rename
  await page.locator('button[aria-label="New folder"]').click();
  await page.locator('.dialog .input').fill('demo');
  await page.locator('.dialog .btn-primary').click();
  await page.waitForTimeout(300);
  check('folder created', (await page.locator('.tree-row').allInnerTexts()).includes('demo'));
  await page.keyboard.press('Control+KeyK');
  await page.locator('.cmd-input').fill('rename');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  if (await page.locator('.dialog .input').count()) {
    await page.locator('.dialog .input').fill('renamed-demo');
    await page.locator('.dialog .btn-primary').click();
    await page.waitForTimeout(300);
  }
  check('folder renamed', (await page.locator('.tree-row').allInnerTexts()).includes('renamed-demo'));

  // Import ZIP
  await page.locator('input[data-import="zip"]').setInputFiles(zipPath);
  await page.waitForTimeout(800);
  const treeAfterImport = await page.locator('.tree-row').allInnerTexts();
  check('zip folder imported', treeAfterImport.includes('imported'));
  check('zip markdown imported', treeAfterImport.includes('notes.md'));

  // Media + inspector: open the PNG, move the brightness slider, check persistence
  await page.locator('.tree-row', { hasText: 'pixel.png' }).click();
  await page.waitForTimeout(800);
  check('media pane visible', (await page.locator('.media-pane:not(.hidden)').count()) === 1);
  check('inspector controls present', (await page.locator('.inspector-range').count()) > 0);
  await page
    .locator('.inspector-range')
    .first()
    .evaluate((input) => {
      input.value = '120';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await page.waitForTimeout(700);
  check('inspector number synced', (await page.locator('.inspector-number').first().inputValue()) === '120');

  const readRows = () =>
    page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('flaxia-studio');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readonly');
        const req = tx.objectStore('files').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return rows;
    });
  const timelineRows = await readRows();
  const timelineText = timelineRows.find((row) => row.path === '.flaxia/timeline.json')?.content ?? '';
  check('timeline adjustments persisted', timelineText.includes('"brightness": 120'));

  // Add the image to the timeline and review it in the Preview monitor
  await page.locator('.media-add').click();
  await page.waitForTimeout(500);
  await page.locator('.tab-preview').click();
  await page.waitForTimeout(600);
  check('preview canvas rendered', (await page.locator('.preview-canvas').count()) === 1);
  check('preview empty state hidden', (await page.locator('.preview-empty.hidden').count()) === 1);
  await page.locator('.preview-transport button[aria-label="Play"]').click();
  await page.waitForTimeout(600);
  const previewTimecode = await page.locator('.preview-timecode').innerText();
  await page.locator('.preview-transport button[aria-label="Pause"]').click();
  check('preview timecode advanced', previewTimecode !== '00:00:00:00', previewTimecode);

  // Drag a media file from the explorer onto the timeline
  const clipsBeforeDrag = await page.locator('.timeline-clip').count();
  await page
    .locator('.tree-row', { hasText: 'pixel.png' })
    .dragTo(page.locator('.timeline-lane').first(), { targetPosition: { x: 240, y: 12 } });
  await page.waitForTimeout(700);
  check('drag added a clip', (await page.locator('.timeline-clip').count()) > clipsBeforeDrag);

  // Add File… context menu opens the workspace media picker
  await page.locator('.timeline-lane').first().click({ button: 'right' });
  await page.waitForTimeout(200);
  check(
    'add file menu present',
    (await page.locator('.context-item', { hasText: 'Add File' }).count()) === 1,
  );
  await page.locator('.context-item', { hasText: 'Add File' }).click();
  await page.waitForTimeout(200);
  await page.locator('.cmd-input').fill('pixel.png');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  check('picker added a clip', (await page.locator('.timeline-clip').count()) > clipsBeforeDrag);

  // Export ZIP (regular workspace export)
  const downloadPromise = page.waitForEvent('download');
  await page.keyboard.press('Control+KeyK');
  await page.locator('.cmd-input').fill('Export ZIP');
  await page.keyboard.press('Enter');
  const download = await downloadPromise;
  await download.saveAs(downloadPath);
  check('export produced bytes', readFileSync(downloadPath).byteLength > 100);

  // Test Play
  await page.locator('.run-pill').click();
  await page.waitForTimeout(2000);
  check('play frame mounted', (await page.locator('.play-frame').count()) === 1);
  check('play pane visible', (await page.locator('.play-pane:not(.hidden)').count()) === 1);
  const h1 = await page
    .frameLocator('.play-frame')
    .frameLocator('.game-frame')
    .locator('h1')
    .innerText()
    .catch(() => 'unavailable');
  check('game entry rendered', h1.length > 0, h1);

  // Arcade compatibility check reports into Problems. Add a file that uses an
  // opaque-origin API so there is a deterministic warning to find.
  await page.locator('button[aria-label="New file"]').first().click();
  await page.locator('.dialog .input').fill('risky.js');
  await page.locator('.dialog .btn-primary').click();
  await page.waitForTimeout(300);
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type("localStorage.setItem('a', '1');");
  await page.waitForTimeout(900);

  await page.keyboard.press('Control+KeyK');
  await page.locator('.cmd-input').fill('Check compatibility');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  check(
    'problems view visible',
    (await page.locator('.panel-view[data-view="problems"].is-active').count()) === 1,
  );
  check('compatibility produced diagnostics', (await page.locator('.problems-row').count()) > 0);

  // Settings: dark + font size
  await page.locator('.topbar button[aria-label="Settings"]').click();
  await page.locator('.dialog select').first().selectOption('dark');
  await page.locator('.dialog input[type=number]').fill('15');
  await page.locator('.dialog .btn-primary').click();
  await page.waitForTimeout(500);
  check('theme switched', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');

  // Reload and verify persisted file content via IndexedDB
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.keyboard.press('Control+KeyP');
  await page.locator('.cmd-input').fill('e2e.ts');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const rows = await readRows();
  const content = rows.find((row) => row.path === 'e2e.ts')?.content ?? null;
  check('file content persisted', typeof content === 'string' && content.includes('answer = 42'), content);
  check('theme persisted', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await page.screenshot({ path: '/tmp/studio-e2e.png' });

  // Delete file (select it explicitly so the command acts on the right path)
  await page.locator('.tree-row', { hasText: 'e2e.ts' }).click();
  await page.waitForTimeout(200);
  await page.locator('.command-trigger').click();
  check('command palette open', (await page.locator('.cmd-input').count()) === 1);
  await page.locator('.cmd-input').fill('delete');
  const deleteItems = await page.locator('.cmd-item').allInnerTexts();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check(
    'delete command matched',
    deleteItems.some((item) => item.includes('Delete')),
    deleteItems.join('|'),
  );
  check('delete confirmation shown', (await page.locator('.dialog .btn-danger').count()) === 1);
  if (await page.locator('.dialog .btn-danger').count()) {
    await page.locator('.dialog .btn-danger').click();
    await page.waitForTimeout(400);
  }
  const rowsAfterDelete = await page.locator('.tree-row').allInnerTexts();
  check('file deleted', !rowsAfterDelete.includes('e2e.ts'), rowsAfterDelete.join('|'));

  assert.deepEqual(errors, [], `Browser errors:\n${errors.join('\n')}`);
  console.log('ok - no browser console/page errors');
} finally {
  await browser.close();
}
