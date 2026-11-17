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

const browser = await chromium.launch({ headless: true });
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
console.log(
  'default panel:',
  await page.locator('[data-panel-tab="timeline"]').getAttribute('aria-selected'),
);
console.log('timeline active:', await page.locator('.panel-view[data-view="timeline"].is-active').count());
console.log(
  'inspector:',
  await page.locator('.inspector:not(.hidden)').count(),
  await page.locator('.inspector-empty-title').innerText(),
);
console.log('preview tab:', await page.locator('.tab-preview').count());
await page.locator('.tab-preview').click();
await page.waitForTimeout(300);
console.log(
  'preview pane:',
  await page.locator('.preview-pane:not(.hidden)').count(),
  'empty:',
  await page.locator('.preview-empty:not(.hidden)').count(),
);
await page.locator('.brand').click();
await page.waitForTimeout(200);

// New file
await page.locator('button[aria-label="New file"]').first().click();
await page.locator('.dialog .input').fill('e2e.ts');
await page.locator('.dialog .btn-primary').click();
await page.waitForTimeout(500);
console.log('new file tab:', await page.locator('.tab[aria-selected="true"] .tab-label').innerText());
await page.locator('.monaco-editor .view-lines').click();
await page.keyboard.type('export const answer = 42;\n');
await page.waitForTimeout(1000);

// New folder + rename
await page.locator('button[aria-label="New folder"]').click();
await page.locator('.dialog .input').fill('demo');
await page.locator('.dialog .btn-primary').click();
await page.waitForTimeout(300);
console.log('folder:', (await page.locator('.tree-row').allInnerTexts()).includes('demo'));
await page.keyboard.press('Control+KeyK');
await page.locator('.cmd-input').fill('rename');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
if (await page.locator('.dialog .input').count()) {
  await page.locator('.dialog .input').fill('renamed-demo');
  await page.locator('.dialog .btn-primary').click();
  await page.waitForTimeout(300);
}
console.log('renamed folder:', (await page.locator('.tree-row').allInnerTexts()).includes('renamed-demo'));

// Import ZIP
await page.locator('input[data-import="zip"]').setInputFiles(zipPath);
await page.waitForTimeout(800);
const treeAfterImport = await page.locator('.tree-row').allInnerTexts();
console.log('imported:', treeAfterImport.includes('imported'), treeAfterImport.includes('notes.md'));

// Media + inspector: open the PNG, move the brightness slider, check persistence
await page.locator('.tree-row', { hasText: 'pixel.png' }).click();
await page.waitForTimeout(800);
console.log(
  'media inspector:',
  await page.locator('.media-pane:not(.hidden)').count(),
  await page.locator('.inspector-content:not(.hidden)').count(),
  await page.locator('.inspector-range').count(),
);
await page
  .locator('.inspector-range')
  .first()
  .evaluate((input) => {
    input.value = '120';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
await page.waitForTimeout(700);
console.log('inspector number:', await page.locator('.inspector-number').first().inputValue());
const timelineText = await page.evaluate(async () => {
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
  return rows.find((row) => row.path === '.flaxia/timeline.json')?.content ?? null;
});
console.log('timeline brightness:', String(timelineText).includes('"brightness": 120'));

// Add the image to the timeline and review it in the Preview monitor
await page.locator('.media-add').click();
await page.waitForTimeout(500);
await page.locator('.tab-preview').click();
await page.waitForTimeout(600);
console.log(
  'preview canvas:',
  await page.locator('.preview-canvas').count(),
  'empty hidden:',
  await page.locator('.preview-empty.hidden').count(),
);
await page.locator('.preview-transport button[aria-label="Play"]').click();
await page.waitForTimeout(600);
const previewTimecode = await page.locator('.preview-timecode').innerText();
await page.locator('.preview-transport button[aria-label="Pause"]').click();
console.log('preview timecode advanced:', previewTimecode !== '00:00:00:00', previewTimecode);

// Drag a media file from the explorer onto the timeline
const clipsBeforeDrag = await page.locator('.timeline-clip').count();
await page
  .locator('.tree-row', { hasText: 'pixel.png' })
  .dragTo(page.locator('.timeline-lane').first(), { targetPosition: { x: 240, y: 12 } });
await page.waitForTimeout(700);
console.log('drag added clip:', (await page.locator('.timeline-clip').count()) > clipsBeforeDrag);

// Add File… context menu opens the workspace media picker
await page.locator('.timeline-lane').first().click({ button: 'right' });
await page.waitForTimeout(200);
console.log('add file menu:', await page.locator('.context-item', { hasText: 'Add File' }).count());
await page.locator('.context-item', { hasText: 'Add File' }).click();
await page.waitForTimeout(200);
await page.locator('.cmd-input').fill('pixel.png');
await page.keyboard.press('Enter');
await page.waitForTimeout(700);
console.log('add file added clip:', (await page.locator('.timeline-clip').count()) > clipsBeforeDrag);

// Export ZIP
const downloadPromise = page.waitForEvent('download');
await page.keyboard.press('Control+KeyK');
await page.locator('.cmd-input').fill('export');
await page.keyboard.press('Enter');
const download = await downloadPromise;
await download.saveAs(downloadPath);
console.log('export bytes:', readFileSync(downloadPath).byteLength);

// Test Play
await page.locator('.run-pill').click();
await page.waitForTimeout(2000);
console.log('play frame:', await page.locator('.play-frame').count());
console.log(
  'play h1:',
  await page
    .frameLocator('.play-frame')
    .frameLocator('.game-frame')
    .locator('h1')
    .innerText()
    .catch(() => 'unavailable'),
);
console.log('play pane:', await page.locator('.play-pane:not(.hidden)').count());

// Settings: dark + font size + manifest
await page.locator('.topbar button[aria-label="Settings"]').click();
await page.locator('.dialog select').first().selectOption('dark');
await page.locator('.dialog input[type=number]').fill('15');
await page.locator('.dialog .btn-primary').click();
await page.waitForTimeout(500);
console.log('theme:', await page.evaluate(() => document.documentElement.dataset.theme));
console.log('font:', await page.evaluate(() => localStorage.getItem('flaxia_studio_settings')));

// Reload and verify persisted file content via IndexedDB
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.keyboard.press('Control+KeyP');
await page.locator('.cmd-input').fill('e2e.ts');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
const content = await page.evaluate(async () => {
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
  return rows.find((row) => row.path === 'e2e.ts')?.content ?? null;
});
console.log('persisted content:', JSON.stringify(content));
console.log('dark after reload:', await page.evaluate(() => document.documentElement.dataset.theme));
await page.screenshot({ path: '/tmp/studio-e2e.png' });

// Delete file
await page.keyboard.press('Control+KeyK');
await page.locator('.cmd-input').fill('delete');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
if (await page.locator('.dialog .btn-danger').count()) {
  await page.locator('.dialog .btn-danger').click();
  await page.waitForTimeout(400);
}
console.log('e2e deleted:', !(await page.locator('.tree-row').allInnerTexts()).includes('e2e.ts'));

console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
