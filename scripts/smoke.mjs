import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('requestfailed', (req) => logs.push(`[reqfail] ${req.url()} ${req.failure()?.errorText}`));
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(800);
console.log('welcome:', await page.locator('.welcome h1').innerText());
console.log('tree rows:', await page.locator('.tree-row').count());

// Open README
await page.locator('.tree-row', { hasText: 'README.md' }).click();
await page.waitForTimeout(1200);
console.log('tabs:', await page.locator('.tab').count());
console.log('monaco:', await page.locator('.monaco-editor').count());
console.log('tab label:', await page.locator('.tab .tab-label').first().innerText());
console.log('editor has markdown:', (await page.locator('.monaco-editor').innerText()).includes('# Welcome'));
await page.screenshot({ path: '/tmp/studio-editor.png' });

// Command palette
await page.keyboard.press('Control+KeyK');
await page.waitForTimeout(300);
console.log('palette:', await page.locator('.cmd-dialog').count());
console.log('palette items:', await page.locator('.cmd-item').count());
await page.screenshot({ path: '/tmp/studio-palette.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

// Settings
await page.locator('.topbar .icon-button[aria-label="Settings"]').click();
await page.waitForTimeout(300);
console.log('settings dialog:', await page.locator('.dialog-title', { hasText: 'Settings' }).count());
await page.screenshot({ path: '/tmp/studio-settings.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

// Quick open
await page.keyboard.press('Control+KeyP');
await page.waitForTimeout(300);
console.log('quick open:', await page.locator('.cmd-input').getAttribute('placeholder'));
await page.keyboard.type('main');
console.log('quick open filtered:', await page.locator('.cmd-item').count());
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
console.log('active tab:', await page.locator('.tab[aria-selected="true"] .tab-label').innerText());

console.log('logs:\n' + logs.join('\n'));
await browser.close();
