import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[err]', e.message));
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.locator('.vm-pill').click();
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(500);
  if ((await page.locator('.vm-pill').getAttribute('data-state')) === 'ready') break;
}
await page.locator('.terminal-host').click();
await page.keyboard.type('fetch https://api.github.com/zen');
await page.keyboard.press('Enter');
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(1000);
  if ((await page.locator('.vm-pill').getAttribute('data-state')) === 'ready') {
    console.log('done', i);
    break;
  }
}
console.log((await page.locator('.xterm-rows').innerText()).slice(-1200));
await page.screenshot({ path: '/tmp/studio-fetch.png' });
const text = await page.locator('.xterm-rows').innerText();
if (text.includes('[exit 1]') || text.includes('Traceback')) {
  throw new Error('Fetch proxy command failed.');
}
console.log('Fetch proxy OK');
await browser.close();
