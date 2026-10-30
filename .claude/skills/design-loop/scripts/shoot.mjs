// Usage: node shoot.mjs <url-or-file> <out-dir> [--dark]
//
// For each width (360, 768, 1024, 1440):
//   - scrolls the whole page so lazy images and scroll-triggered reveals render
//   - saves viewport-sized tiles: <width>/01.png, 02.png, ... (readable by a model)
//   - saves <width>/full.png as a low-detail overview of the whole page
// Writes report.json with overflow, small targets, headings, typography, focus
// visibility and axe-core WCAG results. With --dark, also captures the first
// two tiles at 360 and 1440 with prefers-color-scheme: dark.
//
// Dependencies resolve from this folder's node_modules, then NODE_PATH.
// One-time setup in this folder: npm i && npx playwright install chromium

import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
function load(name) {
  try {
    return require(name);
  } catch {
    console.error(`Missing dependency "${name}". Run in ${new URL('.', import.meta.url).pathname}:\n  npm i && npx playwright install chromium`);
    process.exit(1);
  }
}
const { chromium } = load('playwright');
const axeModule = load('@axe-core/playwright');
const AxeBuilder = axeModule.default || axeModule.AxeBuilder || axeModule;

const args = process.argv.slice(2);
const dark = args.includes('--dark');
const [target, outDir] = args.filter((a) => !a.startsWith('--'));
if (!target || !outDir) {
  console.error('Usage: node shoot.mjs <url-or-file> <out-dir> [--dark]');
  process.exit(1);
}

const url = /^https?:\/\//.test(target)
  ? target
  : existsSync(target)
    ? pathToFileURL(resolve(target)).href
    : target;

// Width -> viewport height. Heights match common devices so tiles look like real screens.
const VIEWPORTS = { 360: 780, 768: 1024, 1024: 768, 1440: 900 };
const MAX_TILES = 10;
const MIN_TARGET = 24;

async function settle(page) {
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  // networkidle can hang on dev servers with open HMR connections; cap it.
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready);

  // Scroll through the page so lazy images load and IntersectionObserver reveals fire.
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.6));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((r) => setTimeout(r, 300));
    await Promise.all(
      [...document.images]
        .filter((img) => !img.complete)
        .map((img) => new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 3000); })),
    );
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 400));
  });
}

async function shootTiles(page, dir, width, height, maxTiles, prefix = '') {
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const count = Math.min(Math.ceil(total / height), maxTiles);
  const files = [];
  for (let i = 0; i < count; i++) {
    const y = i * height;
    const h = Math.min(height, total - y);
    const name = `${prefix}${String(i + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: join(dir, name), fullPage: true, clip: { x: 0, y, width, height: h } });
    files.push(name);
  }
  return { files, truncated: Math.ceil(total / height) > maxTiles, pageHeight: total };
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const report = { url, capturedAt: new Date().toISOString(), viewports: {} };

for (const [w, h] of Object.entries(VIEWPORTS)) {
  const width = Number(w);
  const dir = join(outDir, String(width));
  await mkdir(dir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width, height: h },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
    colorScheme: 'light',
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 300)));

  await settle(page);
  const tiles = await shootTiles(page, dir, width, h, MAX_TILES);
  await page.screenshot({ path: join(dir, 'full.png'), fullPage: true });

  const layout = await page.evaluate(({ width, MIN_TARGET }) => {
    const describe = (el) => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += `#${el.id}`;
      if (typeof el.className === 'string' && el.className.trim()) {
        s += '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.');
      }
      return s;
    };
    const clippedByAncestor = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p);
        if (/(hidden|clip|auto|scroll)/.test(o.overflowX)) return true;
      }
      return false;
    };
    const doc = document.documentElement;

    const overflowing = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > width + 1 || r.left < -1) {
        overflowing.push({ el: describe(el), left: Math.round(r.left), right: Math.round(r.right), clippedByAncestor: clippedByAncestor(el) });
      }
      if (overflowing.length >= 25) break;
    }

    const smallTargets = [];
    const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [tabindex]:not([tabindex="-1"])';
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < MIN_TARGET || r.height < MIN_TARGET) {
        smallTargets.push({
          el: describe(el),
          text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40),
          w: Math.round(r.width),
          h: Math.round(r.height),
          inlineLink: el.tagName === 'A' && getComputedStyle(el).display === 'inline',
        });
      }
      if (smallTargets.length >= 25) break;
    }

    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((hd) => {
      const cs = getComputedStyle(hd);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      return {
        level: Number(hd.tagName[1]),
        text: hd.innerText.trim().slice(0, 60),
        fontSize: parseFloat(cs.fontSize),
        lines: Math.round(hd.getBoundingClientRect().height / lh),
      };
    });

    // Typography inventory from visible text nodes.
    const families = {};
    const sizes = {};
    const longLines = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (!t.textContent.trim()) continue;
      const el = t.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      families[fam] = (families[fam] || 0) + 1;
      const fs = Math.round(parseFloat(cs.fontSize) * 10) / 10;
      sizes[fs] = (sizes[fs] || 0) + 1;
      if (el.matches('p, li') && el.innerText.length > 120) {
        const chars = Math.round(r.width / (parseFloat(cs.fontSize) * 0.5));
        if (chars > 80) longLines.push({ el: describe(el), approxCharsPerLine: chars });
      }
    }

    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      horizontalOverflow: doc.scrollWidth > doc.clientWidth,
      overflowingElements: overflowing,
      smallTargets,
      headings,
      typography: {
        families,
        fontSizes: Object.fromEntries(Object.entries(sizes).sort((a, b) => Number(a[0]) - Number(b[0]))),
        longLines: longLines.slice(0, 10),
      },
    };
  }, { width, MIN_TARGET });

  // Keyboard focus check: Tab through the first 12 stops and record whether focus is visible.
  let focus = null;
  if (width === 1440) {
    focus = [];
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); });
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
        const ring = cs.boxShadow && cs.boxShadow !== 'none';
        return {
          el: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''),
          text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40),
          focusVisible: el.matches(':focus-visible'),
          outline: outline ? `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}` : null,
          boxShadow: ring ? cs.boxShadow.slice(0, 80) : null,
          visibleIndicator: Boolean(outline || ring),
        };
      });
      if (!info) break;
      focus.push(info);
    }
    await page.screenshot({ path: join(dir, 'focus.png') });
  }

  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

  report.viewports[width] = {
    viewportHeight: h,
    pageHeight: tiles.pageHeight,
    tiles: tiles.files,
    tilesTruncated: tiles.truncated,
    ...layout,
    ...(focus ? { focus } : {}),
    consoleErrors,
    axe: axe.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      count: v.nodes.length,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
    })),
  };

  await context.close();
}

// Reduced-motion and dark-mode spot checks on the first screens.
for (const width of [360, 1440]) {
  const h = VIEWPORTS[width];
  const dir = join(outDir, String(width));
  const variants = [{ name: 'reduced-motion', opts: { reducedMotion: 'reduce', colorScheme: 'light' } }];
  if (dark) variants.push({ name: 'dark', opts: { reducedMotion: 'no-preference', colorScheme: 'dark' } });
  for (const v of variants) {
    const context = await browser.newContext({ viewport: { width, height: h }, deviceScaleFactor: 1, ...v.opts });
    const page = await context.newPage();
    await settle(page);
    const t = await shootTiles(page, dir, width, h, 2, `${v.name}-`);
    report.viewports[width][`${v.name}Tiles`] = t.files;
    await context.close();
  }
}

await browser.close();
await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2));

for (const [w, v] of Object.entries(report.viewports)) {
  const serious = v.axe.filter((a) => a.impact === 'serious' || a.impact === 'critical').length;
  const focusMissing = v.focus ? v.focus.filter((f) => !f.visibleIndicator).length : '-';
  console.log(
    `${w}px  tiles:${v.tiles.length}${v.tilesTruncated ? '+' : ''}  overflow:${v.horizontalOverflow ? 'YES' : 'no'}  ` +
    `smallTargets:${v.smallTargets.length}  axe serious/critical:${serious}  focusWithoutIndicator:${focusMissing}  consoleErrors:${v.consoleErrors.length}`,
  );
}
console.log(`Saved to ${outDir}`);
