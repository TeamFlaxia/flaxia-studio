import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem(
    'flaxia_studio_settings',
    JSON.stringify({
      linuxManifestUrl: 'linux/manifest-lite.json',
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
const t0 = Date.now();
await page.locator('.vm-pill').click();
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(500);
  if ((await page.locator('.vm-pill').getAttribute('data-state')) === 'ready') {
    console.log('boot ms', Date.now() - t0);
    break;
  }
}
await page.locator('.terminal-host').click();
await page.keyboard.type('which gcc python3 apk; python3 -c "print(1+1)"');
const t1 = Date.now();
await page.keyboard.press('Enter');
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(500);
  if ((await page.locator('.vm-pill').getAttribute('data-state')) === 'ready') {
    console.log('cmd ms', Date.now() - t1);
    break;
  }
}
console.log(await page.locator('.xterm-rows').innerText());
await page.screenshot({ path: '/tmp/studio-python.png' });
await browser.close();
