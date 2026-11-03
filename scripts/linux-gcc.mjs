import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', (err) => console.log('[pageerror]', err.message));
await page.addInitScript(() => {
  localStorage.setItem(
    'flaxia_studio_settings',
    JSON.stringify({
      linuxManifestUrl: 'linux/manifest-full.json',
      theme: 'light',
      fontSize: 13,
      tabSize: 2,
      wordWrap: false,
      autoSave: true,
      minimap: true,
    }),
  );
});
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.locator('.vm-pill').click();
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(1000);
  const s = await page.locator('.vm-pill').getAttribute('data-state');
  if (s === 'ready' || s === 'error') {
    console.log('boot state', s, i + 1);
    break;
  }
}
console.log('detail', await page.locator('[data-vm-detail]').getAttribute('data-vm-detail'));
await page.locator('.terminal-host').click();
await page.keyboard.type(
  'printf \'#include <stdio.h>\\nint main(void){puts("Hello from gcc");return 0;}\\n\' > hello.c; gcc hello.c -o hello; ./hello',
);
await page.keyboard.press('Enter');
for (let i = 0; i < 180; i++) {
  await page.waitForTimeout(1000);
  const s = await page.locator('.vm-pill').getAttribute('data-state');
  if (s === 'ready' || s === 'error') {
    console.log('cmd done', i + 1, s);
    break;
  }
  if (i % 20 === 19) console.log('still', s);
}
console.log('TERMINAL:\n' + (await page.locator('.xterm-rows').innerText()));
const tree = await page.locator('.tree-row').allInnerTexts();
console.log('TREE:', tree);
if (!tree.includes('hello')) throw new Error('Compiled binary was not saved to the workspace.');

// The binary must survive the round-trip back into the guest.
await page.locator('.terminal-host').click();
await page.keyboard.type('./hello');
await page.keyboard.press('Enter');
for (let i = 0; i < 60; i += 1) {
  await page.waitForTimeout(500);
  if ((await page.locator('.vm-pill').getAttribute('data-state')) === 'ready') break;
}
if (!(await page.locator('.xterm-rows').innerText()).includes('Hello from gcc')) {
  throw new Error('Compiled binary could not be executed after sync.');
}

// Binary files open a metadata/download dialog instead of Monaco.
await page.locator('.tree-row[data-path="hello"]').click();
await page.waitForTimeout(400);
console.log('BINARY DIALOG:', await page.locator('.dialog-body').innerText());
if (!(await page.locator('.dialog-body').innerText()).includes('Binary file')) {
  throw new Error('Binary viewer dialog did not open.');
}
const downloadPromise = page.waitForEvent('download');
await page.locator('.dialog .btn-primary').click();
const download = await downloadPromise;
const path = '/tmp/flaxia-gcc-binary';
await download.saveAs(path);
const magic = readFileSync(path).subarray(0, 4);
console.log('BINARY MAGIC:', [...magic]);
if (magic[0] !== 0x7f || magic[1] !== 0x45 || magic[2] !== 0x4c || magic[3] !== 0x46) {
  throw new Error('Downloaded artifact is not an ELF binary.');
}
await page.screenshot({ path: '/tmp/studio-gcc.png' });
await browser.close();
