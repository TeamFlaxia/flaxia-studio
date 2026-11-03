import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await page.addInitScript(() => {
  localStorage.setItem(
    'flaxia_studio_settings',
    JSON.stringify({
      linuxManifestUrl: 'linux/manifest-full.json',
      linuxNetwork: false,
      theme: 'light',
      fontSize: 13,
      tabSize: 2,
      wordWrap: false,
      autoSave: true,
      minimap: true,
    }),
  );
});
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle', timeout: 60_000 });

const bootStart = Date.now();
await page.locator('.vm-pill').click();
for (let i = 0; i < 160; i += 1) {
  await page.waitForTimeout(250);
  if ((await page.locator('.vm-pill').getAttribute('data-state')) === 'ready') break;
}
const detail = await page.locator('[data-vm-detail]').getAttribute('data-vm-detail');
console.log('boot:', detail, `${Date.now() - bootStart} ms`);
if (!detail?.includes('Ready') || detail.includes('(one-shot)')) {
  throw new Error(`Persistent session was not used: ${detail}`);
}

const exitedCount = async () =>
  ((await page.locator('.output-view').innerText()).match(/Linux exited/g) ?? []).length;

async function run(command, timeout = 60_000) {
  const before = await exitedCount();
  const started = Date.now();
  await page.locator('.terminal-host').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (count) =>
      (document.querySelector('.output-view')?.innerText.match(/Linux exited/g) ?? []).length > count,
    before,
    { timeout },
  );
  console.log(`run ${Date.now() - started} ms: ${command.slice(0, 60)}`);
}

await run('echo session');
await run('printf \'#include <stdio.h>\\nint main(void){puts("SESSION OK");return 0;}\\n\' > main.c');
await run('gcc main.c');
await run('ls -l a.out');
await run('./a.out');

const files = await page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('flaxia-studio', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return await new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readonly');
    const request = tx.objectStore('files').getAll();
    request.onsuccess = () =>
      resolve(request.result.map((row) => ({ path: row.path, binary: row.binary === true })));
    request.onerror = () => reject(request.error);
  });
});
const binary = files.find((file) => file.path === 'a.out');
if (!binary?.binary) throw new Error('a.out was not persisted as a binary artifact.');

const terminal = await page.locator('.xterm-rows').innerText();
if (!terminal.includes('SESSION OK')) throw new Error('Compiled program did not run in the session.');
if (errors.length > 0) throw new Error(`Browser errors:\n${errors.join('\n')}`);
console.log('Session test OK');
await browser.close();
