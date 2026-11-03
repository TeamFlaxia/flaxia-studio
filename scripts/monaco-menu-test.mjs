import { chromium } from 'playwright';

async function menuBackground(page) {
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  await page.locator('.tree-row', { hasText: 'README.md' }).click();
  await page.waitForTimeout(600);
  await page.locator('.monaco-editor .view-lines').click({ button: 'right' });
  await page.locator('.monaco-menu-container').first().waitFor({ state: 'attached' });
  await page.waitForTimeout(300);
  return await page
    .locator('.monaco-menu-container')
    .first()
    .evaluate((element) => {
      const root = element.getRootNode();
      const surface = root.querySelector('.monaco-scrollable-element');
      if (!surface) throw new Error('Monaco menu surface missing');
      const style = getComputedStyle(surface);
      return {
        background: style.backgroundColor,
        color: style.color,
        border: style.border,
      };
    });
}

const browser = await chromium.launch({ headless: true });
const light = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await light.addInitScript(() => {
  localStorage.setItem(
    'flaxia_studio_settings',
    JSON.stringify({
      theme: 'light',
      fontSize: 13,
      tabSize: 2,
      wordWrap: false,
      autoSave: true,
      minimap: true,
      linuxNetwork: false,
      linuxManifestUrl: 'auto',
    }),
  );
});
const lightMenu = await menuBackground(light);
console.log('light menu', lightMenu);
if (lightMenu.background === 'rgba(0, 0, 0, 0)') throw new Error('Light menu has no surface background.');
if (!lightMenu.border.includes('1px')) throw new Error('Light menu has no border.');

const dark = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await dark.addInitScript(() => {
  localStorage.setItem('flaxia_theme', 'dark');
  localStorage.setItem(
    'flaxia_studio_settings',
    JSON.stringify({
      theme: 'dark',
      fontSize: 13,
      tabSize: 2,
      wordWrap: false,
      autoSave: true,
      minimap: true,
      linuxNetwork: false,
      linuxManifestUrl: 'auto',
    }),
  );
});
const darkMenu = await menuBackground(dark);
console.log('dark menu', darkMenu);
if (darkMenu.background === lightMenu.background) throw new Error('Dark menu did not use the dark surface.');

await browser.close();
console.log('Monaco context menu test OK');
