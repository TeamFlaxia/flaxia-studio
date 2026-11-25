/**
 * Multimedia E2E gate for Flaxia Studio.
 *
 * Run against a preview server started with:
 *   npm run preview -- --port 4173
 *   node scripts/e2e-multimedia.mjs
 *
 * The track / waveform / piano-roll / frame-export selectors are contracts for
 * the upcoming UI. When one of them is still missing the corresponding check
 * is recorded as an unverified item instead of aborting the whole run; set
 * STRICT_MULTIMEDIA=1 to turn those gaps into hard failures.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE_URL = process.env.STUDIO_URL ?? 'http://localhost:4173/';
const SAMPLE_PNG = '/tmp/flaxia-multimedia-sample.png';
const SAMPLE_WAV = '/tmp/flaxia-multimedia-tone.wav';
const FRAME_ZIP = '/tmp/flaxia-multimedia-frames.zip';
const SCREENSHOT = '/tmp/studio-multimedia.png';

/** Planned selector first, then the media input that exists today. */
const MEDIA_INPUT_SELECTORS = [
  'input[data-media="import"]',
  'input[data-import="media"]',
  'input[type="file"][accept*="image"]',
];

const unverified = [];

function check(label, condition, detail) {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${detail}`}`);
  console.log(`ok - ${label}`);
}

function skip(label, reason) {
  unverified.push(`${label}: ${reason}`);
  console.log(`skip - ${label}: ${reason}`);
}

function info(label, detail) {
  console.log(`info - ${label}${detail === undefined ? '' : `: ${detail}`}`);
}

/** Small PCM WAV so the browser can decode the waveform deterministically. */
function makeWavBytes(seconds = 3, sampleRate = 8000) {
  const samples = seconds * sampleRate;
  const dataSize = samples * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); // PCM
  bytes.writeUInt16LE(1, 22); // mono
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 8000);
    bytes.writeInt16LE(value, 44 + i * 2);
  }
  return bytes;
}

writeFileSync(
  SAMPLE_PNG,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
writeFileSync(SAMPLE_WAV, makeWavBytes());
if (existsSync(FRAME_ZIP)) rmSync(FRAME_ZIP);

async function firstExisting(page, selectors) {
  for (const selector of selectors) {
    if ((await page.locator(selector).count()) > 0) return selector;
  }
  return null;
}

async function closePalette(page) {
  if ((await page.locator('.cmd-input').count()) > 0) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
  }
}

/** Opens the palette, filters it and returns the visible command labels. */
async function runCommandQuery(page, query) {
  await closePalette(page);
  if ((await page.locator('.command-trigger').count()) > 0) {
    await page.locator('.command-trigger').first().click();
  } else {
    await page.keyboard.press('Control+KeyK');
  }
  await page.locator('.cmd-input').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.cmd-input').fill(query);
  await page.waitForTimeout(180);
  return page.locator('.cmd-item').allInnerTexts();
}

async function addFromExplorer(page, fileName, lane) {
  const row = page.locator('.tree-row', { hasText: fileName }).first();
  if ((await row.count()) === 0) return false;
  const before = await page.locator('.timeline-clip').count();
  await row.dragTo(lane, { targetPosition: { x: 160, y: 12 } });
  await page.waitForTimeout(700);
  return (await page.locator('.timeline-clip').count()) > before;
}

/** Places the playhead at 40% of a clip using the ruler's coordinate space. */
async function seekIntoClip(page, clip) {
  const geometry = await clip.evaluate((node) => {
    const lane = node.closest('.timeline-lane');
    const ruler = document.querySelector('.timeline-ruler');
    const laneRect = lane?.getBoundingClientRect();
    const rulerRect = ruler?.getBoundingClientRect();
    return {
      leftPx: Number.parseFloat(node.style.left) || 0,
      widthPx: Number.parseFloat(node.style.width) || 0,
      laneLeft: laneRect?.left ?? 0,
      rulerLeft: rulerRect?.left ?? 0,
      rulerTop: rulerRect?.top ?? 0,
      rulerHeight: rulerRect?.height ?? 0,
      rulerRight: rulerRect?.right ?? 0,
    };
  });
  const x = Math.min(geometry.rulerRight - 4, geometry.laneLeft + geometry.leftPx + geometry.widthPx * 0.4);
  await page.mouse.click(x, geometry.rulerTop + Math.max(4, geometry.rulerHeight / 2));
  await page.waitForTimeout(220);
  const playheadPx = await page
    .locator('.timeline-playhead')
    .evaluate((node) => Number.parseFloat(node.style.left) || 0);
  const labelWidth = geometry.laneLeft - geometry.rulerLeft;
  const timePx = playheadPx - labelWidth;
  return {
    inside:
      geometry.widthPx > 40 &&
      timePx > geometry.leftPx + 4 &&
      timePx < geometry.leftPx + geometry.widthPx - 4,
    detail: `clip=${geometry.leftPx}..${geometry.leftPx + geometry.widthPx}, playhead=${timePx}, label=${labelWidth}`,
  };
}

async function dragClipBy(page, clip, dx) {
  const box = await clip.boundingBox();
  if (!box) throw new Error('clip has no bounding box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(420);
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`);
  });
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(400);

  // 1. Startup: the timeline panel is visible.
  const tab = page.locator('[data-panel-tab="timeline"]');
  check('timeline panel tab present', (await tab.count()) === 1);
  check('timeline panel selected', (await tab.getAttribute('aria-selected')) === 'true');
  check(
    'timeline view active',
    (await page.locator('.panel-view[data-view="timeline"].is-active').count()) === 1,
  );
  check('timeline ruler rendered', (await page.locator('.timeline-ruler').count()) === 1);
  check('timeline playhead rendered', (await page.locator('.timeline-playhead').count()) === 1);

  let hasClips = false;
  // 2. Import sample image / audio and add them to the timeline.
  const mediaInputSelector = await firstExisting(page, MEDIA_INPUT_SELECTORS);
  if (mediaInputSelector === null) {
    skip('sample media import', `no media input matched: ${MEDIA_INPUT_SELECTORS.join(', ')}`);
  } else {
    info('media input selector', mediaInputSelector);
    await page.locator(mediaInputSelector).setInputFiles([SAMPLE_PNG, SAMPLE_WAV]);
    await page.waitForTimeout(900);
    const rows = await page.locator('.tree-row').allInnerTexts();
    check(
      'sample image and audio imported',
      rows.some((text) => text.includes('sample.png')) && rows.some((text) => text.includes('tone.wav')),
      rows.join('|'),
    );

    if ((await page.locator('.timeline-lane').count()) === 0) {
      const video = page.locator('.timeline-toolbar button[aria-label="Add video track"]');
      const audio = page.locator('.timeline-toolbar button[aria-label="Add audio track"]');
      if ((await video.count()) > 0) await video.click();
      if ((await audio.count()) > 0) await audio.click();
      await page.waitForTimeout(400);
    }
    const videoLane = page.locator('.timeline-track[data-kind="video"] .timeline-lane').first();
    const audioLane = page.locator('.timeline-track[data-kind="audio"] .timeline-lane').first();
    if ((await videoLane.count()) === 0 || (await audioLane.count()) === 0) {
      skip('sample media on timeline', 'video/audio lane not available');
    } else {
      const before = await page.locator('.timeline-clip').count();
      const imageAdded = await addFromExplorer(page, 'sample.png', videoLane);
      const audioAdded = await addFromExplorer(page, 'tone.wav', audioLane);
      const after = await page.locator('.timeline-clip').count();
      check(
        'image and audio added as clips',
        imageAdded && audioAdded && after >= before + 2,
        `${before} -> ${after} (image=${imageAdded}, audio=${audioAdded})`,
      );
      hasClips = after > before;

      // 3/4. Split, undo and redo on the timeline itself.
      if (!hasClips) {
        skip('split / history on timeline', 'no clips were added');
      } else {
        const clip = page.locator('.timeline-clip').first();
        const clipId = await clip.getAttribute('data-clip');
        const target = clipId ? page.locator(`.timeline-clip[data-clip="${clipId}"]`) : clip;
        const countBefore = await page.locator('.timeline-clip').count();
        const seek = await seekIntoClip(page, target);
        check('playhead seeked inside clip', seek.inside, seek.detail);
        await target.click();
        await page.locator('.timeline-timecode').click();
        await page.keyboard.press('s');
        await page.waitForTimeout(500);
        const countSplit = await page.locator('.timeline-clip').count();
        check(
          'S splits the selected clip',
          countSplit === countBefore + 1,
          `${countBefore} -> ${countSplit}`,
        );
        await page.keyboard.press('Control+KeyZ');
        await page.waitForTimeout(500);
        const countUndone = await page.locator('.timeline-clip').count();
        check(
          'Ctrl+Z undoes the timeline split',
          countUndone === countBefore,
          `${countSplit} -> ${countUndone}`,
        );
        await page.keyboard.press('Control+Shift+KeyZ');
        await page.waitForTimeout(500);
        const countRedone = await page.locator('.timeline-clip').count();
        check(
          'Ctrl+Shift+Z redoes the timeline split',
          countRedone === countSplit,
          `${countUndone} -> ${countRedone}`,
        );
      }

      // 7. Waveform for the selected audio clip.
      const audioClip = page.locator('.timeline-clip[data-kind="audio"]').first();
      if ((await audioClip.count()) === 0) {
        skip('audio waveform', 'no audio clip found');
      } else {
        await audioClip.click();
        await page.waitForTimeout(420);
        const canvas = page.locator('.waveform-canvas').first();
        if ((await canvas.count()) === 0) {
          skip('audio waveform', '.waveform-canvas not present');
        } else {
          check('waveform canvas visible', await canvas.isVisible());
          const wave = await canvas.evaluate((node) => {
            let opaque = 0;
            let error = null;
            try {
              const context = node.getContext('2d');
              const pixels = context?.getImageData(0, 0, node.width, node.height).data;
              if (pixels) {
                for (let i = 3; i < pixels.length; i += 4) {
                  if (pixels[i] > 0) opaque += 1;
                }
              }
            } catch (cause) {
              error = String(cause);
            }
            return {
              width: node.width,
              height: node.height,
              dataUrlLength: node.toDataURL().length,
              opaque,
              error,
            };
          });
          info('waveform pixels', JSON.stringify(wave));
          check('waveform canvas has width', wave.error === null && wave.width > 0, JSON.stringify(wave));
          check(
            'waveform canvas has drawn pixels',
            wave.error === null && wave.opaque > 0,
            JSON.stringify(wave),
          );
          check(
            'waveform canvas data URL is non-trivial',
            wave.dataUrlLength > 100,
            String(wave.dataUrlLength),
          );
        }
      }
    }
  }

  // 5. Track M / S / lock buttons expose and toggle aria-pressed.
  for (const selector of ['.track-mute', '.track-solo', '.track-lock']) {
    const button = page.locator(selector).first();
    if ((await button.count()) === 0) {
      skip(`${selector} toggle`, 'selector not present');
      continue;
    }
    const before = await button.getAttribute('aria-pressed');
    await button.click();
    await page.waitForTimeout(180);
    const after = await button.getAttribute('aria-pressed');
    check(
      `${selector} aria-pressed toggles`,
      before !== after && (after === 'true' || after === 'false'),
      `${before} -> ${after}`,
    );
  }

  // 6. A locked track keeps clip startMs (style.left) when dragged.
  if (!(await page.locator('.track-lock').count())) {
    skip('locked track keeps clip position', '.track-lock not present');
  } else if (!hasClips) {
    skip('locked track keeps clip position', 'no clips to drag');
  } else {
    const target = await page.evaluate(() => {
      const locks = [...document.querySelectorAll('.track-lock')];
      for (const clip of document.querySelectorAll('.timeline-clip')) {
        const button = clip.closest('.timeline-track')?.querySelector('.track-lock');
        if (button) return { lockIndex: locks.indexOf(button), clipId: clip.dataset.clip ?? null };
      }
      return null;
    });
    if (target === null) {
      skip('locked track keeps clip position', 'no clip inside a track with a lock button');
    } else {
      const lock = page.locator('.track-lock').nth(target.lockIndex);
      const clip = target.clipId
        ? page.locator(`.timeline-clip[data-clip="${target.clipId}"]`)
        : page.locator('.timeline-clip').first();
      // Control: verify an unlocked drag really moves the clip first.
      if ((await lock.getAttribute('aria-pressed')) === 'true') {
        await lock.click();
        await page.waitForTimeout(180);
      }
      const leftBefore = await clip.evaluate((node) => node.style.left);
      await dragClipBy(page, clip, 140);
      const leftControl = await clip.evaluate((node) => node.style.left);
      if (leftControl === leftBefore) {
        skip(
          'locked track keeps clip position',
          'unlocked drag did not move clip; assertion would be vacuous',
        );
      } else {
        info('control drag moved clip', `${leftBefore} -> ${leftControl}`);
        if ((await lock.getAttribute('aria-pressed')) !== 'true') {
          await lock.click();
          await page.waitForTimeout(180);
        }
        const pressed = await lock.getAttribute('aria-pressed');
        if (pressed !== null) check('track lock reports pressed state', pressed === 'true', String(pressed));
        await dragClipBy(page, clip, 140);
        const leftLocked = await clip.evaluate((node) => node.style.left);
        check(
          'locked track keeps clip startMs',
          leftLocked === leftControl,
          `${leftControl} -> ${leftLocked}`,
        );
      }
    }
  }

  // 8. Piano roll opens from the palette and accepts a new note.
  const pianoItems = await runCommandQuery(page, 'Music: Open Piano Roll');
  if (!pianoItems.some((text) => /open piano roll/i.test(text))) {
    skip('piano roll note entry', `command not found: ${pianoItems.join('|') || '(empty)'}`);
    await closePalette(page);
  } else {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    if ((await page.locator('.piano-roll').count()) === 0) {
      skip('piano roll note entry', '.piano-roll not shown after command');
    } else {
      const canvas = page.locator('.piano-roll-canvas').first();
      if ((await canvas.count()) > 0) {
        const box = await canvas.boundingBox();
        check('piano roll canvas rendered', (box?.width ?? 0) > 0, JSON.stringify(box));
      } else {
        skip('piano roll canvas', '.piano-roll-canvas not present');
      }
      const notes = page.locator('.piano-roll-note');
      const beforeNotes = await notes.count();
      const surface = (await canvas.count()) > 0 ? canvas : page.locator('.piano-roll').first();
      const box = await surface.boundingBox();
      check('piano roll has a clickable surface', (box?.width ?? 0) > 0, JSON.stringify(box));
      await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);
      await page.waitForTimeout(420);
      const afterNotes = await notes.count();
      check('piano roll note added on click', afterNotes > beforeNotes, `${beforeNotes} -> ${afterNotes}`);
    }
  }

  // 9. Export frames produces a ZIP download.
  const exportItems = await runCommandQuery(page, 'Export frames');
  if (!exportItems.some((text) => /export frames/i.test(text))) {
    skip('Export frames download', `command not found: ${exportItems.join('|') || '(empty)'}`);
    await closePalette(page);
  } else {
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
    await page.keyboard.press('Enter');
    if ((await page.locator('.dialog .btn-primary').count()) > 0) {
      await page.locator('.dialog .btn-primary').click();
    }
    let download;
    try {
      download = await downloadPromise;
    } catch (cause) {
      check('Export frames download started', false, String(cause));
    }
    check('Export frames download started', true, download.suggestedFilename());
    await download.saveAs(FRAME_ZIP);
    const zipBytes = existsSync(FRAME_ZIP) ? readFileSync(FRAME_ZIP).byteLength : 0;
    check('Export frames ZIP has bytes', zipBytes > 0, `${zipBytes} bytes`);
  }

  // 11. Screenshot artifact (10. is the console/pageerror assertion below).
  await page.screenshot({ path: SCREENSHOT });
  check('screenshot saved', existsSync(SCREENSHOT) && readFileSync(SCREENSHOT).byteLength > 0, SCREENSHOT);

  assert.deepEqual(errors, [], `Browser errors:\n${errors.join('\n')}`);
  console.log('ok - no browser console/page errors');

  if (process.env.STRICT_MULTIMEDIA === '1') {
    check('all multimedia scenarios verified', unverified.length === 0, unverified.join(' | '));
  }
} finally {
  await browser.close();
  if (unverified.length === 0) {
    console.log('未検証項目: なし');
  } else {
    console.log(`未検証項目 (${unverified.length} 件):\n- ${unverified.join('\n- ')}`);
  }
}
