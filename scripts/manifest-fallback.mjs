import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.addInitScript(() =>
  localStorage.setItem(
    'flaxia_studio_settings',
    JSON.stringify({
      linuxManifestUrl: '/linux/manifest.json',
      linuxNetwork: false,
      theme: 'light',
      fontSize: 13,
      tabSize: 2,
      wordWrap: false,
      autoSave: true,
      minimap: true,
    }),
  ),
);
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.locator('.vm-pill').click();
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(500);
  const s = await page.locator('.vm-pill').getAttribute('data-state');
  if (s === 'ready' || s === 'error') {
    console.log('state', s, i / 2);
    break;
  }
}
console.log('detail', await page.locator('[data-vm-detail]').getAttribute('data-vm-detail'));
console.log((await page.locator('.xterm-rows').innerText()).slice(-300));
if ((await page.locator('.vm-pill').getAttribute('data-state')) !== 'ready')
  throw new Error('legacy manifest fallback failed');
await browser.close();
