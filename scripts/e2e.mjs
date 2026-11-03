import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { chromium } from 'playwright';

const zipPath = '/tmp/flaxia-import.zip';
writeFileSync(
  zipPath,
  zipSync({ 'imported/hello.txt': strToU8('imported hello\n'), 'notes.md': strToU8('# imported notes\n') }),
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
await page.locator('input[type=file]').setInputFiles(zipPath);
await page.waitForTimeout(800);
const treeAfterImport = await page.locator('.tree-row').allInnerTexts();
console.log('imported:', treeAfterImport.includes('imported'), treeAfterImport.includes('notes.md'));

// Export ZIP
const downloadPromise = page.waitForEvent('download');
await page.keyboard.press('Control+KeyK');
await page.locator('.cmd-input').fill('export');
await page.keyboard.press('Enter');
const download = await downloadPromise;
await download.saveAs(downloadPath);
console.log('export bytes:', readFileSync(downloadPath).byteLength);

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
    const req = indexedDB.open('flaxia-studio', 1);
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
