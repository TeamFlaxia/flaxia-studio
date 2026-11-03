import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[flaxia]')) console.log(t);
});
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.locator('.vm-pill').click();
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(500);
  if ((await page.locator('.vm-pill').getAttribute('data-state')) === 'ready') break;
}
await page.locator('.terminal-host').click();
await page.keyboard.type('fetch https://api.github.com/zen');
await page.keyboard.press('Enter');
for (let i = 0; i < 80; i++) {
  await page.waitForTimeout(1000);
  if ((await page.locator('.vm-pill').getAttribute('data-state')) === 'ready') {
    console.log('done', i);
    break;
  }
}
console.log((await page.locator('.xterm-rows').innerText()).slice(-800));
await browser.close();
