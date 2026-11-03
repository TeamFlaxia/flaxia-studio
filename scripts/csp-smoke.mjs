import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('[console] ' + m.text());
});
page.on('requestfailed', (r) => errors.push('[reqfail] ' + r.url() + ' ' + r.failure()?.errorText));
await page.goto('http://localhost:4174/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(800);
await page.locator('.tree-row', { hasText: 'README.md' }).click();
await page.waitForTimeout(800);
console.log('monaco:', await page.locator('.monaco-editor').count());
await page.keyboard.press('Control+KeyK');
await page.waitForTimeout(200);
console.log('palette:', await page.locator('.cmd-dialog').count());
await page.keyboard.press('Escape');
await page.locator('.vm-pill').click();
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  const s = await page.locator('.vm-pill').getAttribute('data-state');
  if (s === 'ready' || s === 'error') {
    console.log('linux:', s, i + 1);
    break;
  }
}
await page.screenshot({ path: '/tmp/studio-csp.png' });
console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
