// Usage: node shoot.mjs <url-or-file> <out-dir>
// Takes full-page screenshots at 360, 768, 1024, 1440px and writes report.json
// with horizontal overflow, overflowing elements, undersized targets and axe-core results.

import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , target, outDir] = process.argv;
if (!target || !outDir) {
  console.error('Usage: node shoot.mjs <url-or-file> <out-dir>');
  process.exit(1);
}

const url = /^https?:\/\//.test(target)
  ? target
  : existsSync(target)
    ? pathToFileURL(resolve(target)).href
    : target;

const WIDTHS = [360, 768, 1024, 1440];
const MIN_TARGET = 24;

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const report = { url, capturedAt: new Date().toISOString(), viewports: {} };

for (const width of WIDTHS) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(300);

  await page.screenshot({ path: `${outDir}/${width}.png`, fullPage: true });

  const layout = await page.evaluate(({ width, MIN_TARGET }) => {
    const describe = (el) => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += `#${el.id}`;
      if (el.classList.length) s += '.' + [...el.classList].slice(0, 3).join('.');
      return s;
    };
    const doc = document.documentElement;
    const overflowing = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > width + 1 || r.left < -1) {
        overflowing.push({ el: describe(el), left: Math.round(r.left), right: Math.round(r.right) });
      }
      if (overflowing.length >= 25) break;
    }

    const smallTargets = [];
    const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [tabindex]:not([tabindex="-1"])';
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = getComputedStyle(el);
      const inlineLink = el.tagName === 'A' && style.display === 'inline';
      if (r.width < MIN_TARGET || r.height < MIN_TARGET) {
        smallTargets.push({
          el: describe(el),
          text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40),
          w: Math.round(r.width),
          h: Math.round(r.height),
          inlineLink,
        });
      }
      if (smallTargets.length >= 25) break;
    }

    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
      level: Number(h.tagName[1]),
      text: h.innerText.trim().slice(0, 60),
    }));

    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      horizontalOverflow: doc.scrollWidth > doc.clientWidth,
      pageHeight: doc.scrollHeight,
      overflowingElements: overflowing,
      smallTargets,
      headings,
    };
  }, { width, MIN_TARGET });

  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

  report.viewports[width] = {
    ...layout,
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

await browser.close();
await writeFile(`${outDir}/report.json`, JSON.stringify(report, null, 2));

for (const [w, v] of Object.entries(report.viewports)) {
  const serious = v.axe.filter((a) => a.impact === 'serious' || a.impact === 'critical').length;
  console.log(`${w}px  overflow:${v.horizontalOverflow ? 'YES' : 'no'}  smallTargets:${v.smallTargets.length}  axe serious/critical:${serious}  consoleErrors:${v.consoleErrors.length}`);
}
console.log(`Saved to ${outDir}`);
