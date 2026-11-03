import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.locator('.vm-pill').click();
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(500);
  if ((await page.locator('.vm-pill').getAttribute('data-state')) === 'ready') break;
}
async function run(cmd) {
  await page.locator('.terminal-host').click();
  await page.keyboard.type(cmd);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(500);
    if ((await page.locator('.vm-pill').getAttribute('data-state')) === 'ready') return;
  }
  throw new Error('timeout: ' + cmd);
}
await run(`printf '#include <stdio.h>\\nint main(void){puts("EXEC OK");return 0;}\\n' > main.c`);
await run('gcc main.c');
await run('./a.out');
const text = await page.locator('.xterm-rows').innerText();
console.log(text.slice(-600));
if (!text.includes('EXEC OK')) throw new Error('a.out did not execute');
console.log('separate a.out execution OK');
await browser.close();
