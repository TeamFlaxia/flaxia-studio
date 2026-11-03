import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
console.log('TREE:', await page.locator('.tree-row').allInnerTexts());
await page.screenshot({ path: '/tmp/studio-gcc.png' });
await browser.close();
