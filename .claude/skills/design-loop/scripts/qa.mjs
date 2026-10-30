// Usage: node qa.mjs <url-or-file> <out-dir>
//
// Real-browser smoke test at two profiles:
//   desktop: 1440x900
//   mobile:  390x844, touch, CPU throttled 4x
// Writes <out-dir>/qa.json with:
//   - console errors, page errors, failed requests, HTTP 4xx/5xx, dialogs
//   - broken images, images without width/height, failed fonts, broken #anchors, href="#" placeholders
//   - lab performance: LCP, FCP, CLS (with shifting elements), long tasks, approx. blocking time,
//     load timing, request count, transfer size, third-party origins
//   - keyboard traversal (Tab): stops, traps, focus on hidden elements
//   - click smoke test of safe interactive elements: click failed, no observable effect,
//     navigated away, new console errors
// Lab numbers come from a single run on this machine. They are indicators, not field data.
// Entries marked as "leads" need confirmation before they are reported as defects.
//
// Dependencies resolve from this folder's node_modules, then NODE_PATH.
// One-time setup in this folder: npm i && npx playwright install chromium

import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error(`Missing dependency "playwright". Run in ${new URL('.', import.meta.url).pathname}:\n  npm i && npx playwright install chromium`);
  process.exit(1);
}

const [, , target, outDir] = process.argv;
if (!target || !outDir) {
  console.error('Usage: node qa.mjs <url-or-file> <out-dir>');
  process.exit(1);
}

const url = /^https?:\/\//.test(target)
  ? target
  : existsSync(target)
    ? pathToFileURL(resolve(target)).href
    : target;

const PROFILES = {
  desktop: { viewport: { width: 1440, height: 900 }, mobile: false, cpu: 1 },
  mobile: { viewport: { width: 390, height: 844 }, mobile: true, cpu: 4 },
};

const THRESHOLDS = { lcpMs: 2500, cls: 0.1, blockingTimeMs: 200 };
const MAX_CLICKS = 25;
const MAX_TABS = 60;

// Runs before any page script. Collects LCP, CLS and long tasks.
const PERF_INIT = `
window.__qa = { lcp: 0, cls: 0, shifts: [], longTasks: [], heartbeatBlockedMs: 0 };
// Independent main-thread measure: a 20ms timer that records how late each tick fires.
// Used alongside the longtask observer because that observer occasionally drops entries on the first page of a run.
try {
  let expected = performance.now() + 20;
  const tick = () => {
    const now = performance.now();
    const late = now - expected;
    if (late > 50) window.__qa.heartbeatBlockedMs += late - 50;
    expected = performance.now() + 20;
    setTimeout(tick, 20);
  };
  setTimeout(tick, 20);
} catch (e) {}
try {
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__qa.lcp = e.startTime; })
    .observe({ type: 'largest-contentful-paint', buffered: true });
} catch (e) {}
try {
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (e.hadRecentInput) continue;
      window.__qa.cls += e.value;
      window.__qa.shifts.push({
        value: Math.round(e.value * 10000) / 10000,
        atMs: Math.round(e.startTime),
        elements: (e.sources || []).slice(0, 2).map((s) => {
          const n = s.node;
          if (!n || !n.nodeName) return '';
          return n.nodeName.toLowerCase() + (n.id ? '#' + n.id : '');
        }),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
} catch (e) {}
try {
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__qa.longTasks.push({ startMs: Math.round(e.startTime), durationMs: Math.round(e.duration) });
  }).observe({ type: 'longtask', buffered: true });
} catch (e) {}
`;

async function settle(page) {
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready);
  // Scroll through so lazy content loads and any late layout shifts are counted.
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.6));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 1200));
  });
}

// Tag safe interactive elements with data-qa-idx so they can be located after DOM changes.
async function markCandidates(page) {
  return page.evaluate((MAX) => {
    const describe = (el) => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += `#${el.id}`;
      if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
      return s;
    };
    const sel = 'button, [role=button], [role=tab], summary, [aria-expanded], [aria-controls], a[href^="#"]';
    const out = [];
    let i = 0;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.tagName === 'BUTTON' && el.type === 'submit' && el.closest('form')) continue;
      const label = (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40);
      // Never click anything that looks destructive or transactional.
      if (/(delete|remove|pay|buy|order|purchase|send|submit|sign out|log out|удалить|оплат|купить|заказ|отправ|выйти)/i.test(label)) continue;
      el.setAttribute('data-qa-idx', String(i));
      const alreadyActive = el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true' || Boolean(el.getAttribute('aria-current'));
      out.push({ idx: i, el: describe(el), text: label, alreadyActive });
      i++;
      if (i >= MAX) break;
    }
    return out;
  }, MAX_CLICKS);
}

const stateHash = (page) =>
  page.evaluate(() => {
    const s = document.documentElement.outerHTML + '|' + location.hash + '|' + Math.round(window.scrollY);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  });

async function runProfile(browser, name, p) {
  const context = await browser.newContext({
    viewport: p.viewport,
    deviceScaleFactor: 1,
    isMobile: p.mobile,
    hasTouch: p.mobile,
    reducedMotion: 'no-preference',
  });
  await context.addInitScript(PERF_INIT);
  const page = await context.newPage();
  if (p.cpu > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: p.cpu });
  }

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const badStatus = [];
  const dialogs = [];
  const thirdParty = new Set();
  let pageOrigin = 'null';
  try { pageOrigin = new URL(url).origin; } catch {}

  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  page.on('requestfailed', (r) => failedRequests.push({ url: r.url().slice(0, 160), reason: (r.failure() || {}).errorText || '' }));
  page.on('response', (r) => {
    const s = r.status();
    if (s >= 400) badStatus.push({ url: r.url().slice(0, 160), status: s });
    try {
      const u = new URL(r.url());
      if (/^https?:$/.test(u.protocol) && u.origin !== pageOrigin) thirdParty.add(u.origin);
    } catch {}
  });
  page.on('dialog', (d) => { dialogs.push(d.message().slice(0, 120)); d.dismiss().catch(() => {}); });

  await settle(page);

  // ---- performance (lab) ----
  const perf = await page.evaluate(() => {
    const q = window.__qa || { lcp: 0, cls: 0, shifts: [], longTasks: [] };
    const nav = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const res = performance.getEntriesByType('resource');
    const blockingLongTasks = q.longTasks.reduce((s, t) => s + Math.max(0, t.durationMs - 50), 0);
    const blockingHeartbeat = Math.round(q.heartbeatBlockedMs || 0);
    const blocking = Math.max(blockingLongTasks, blockingHeartbeat);
    return {
      blockingBreakdownMs: { longTaskObserver: Math.round(blockingLongTasks), timerHeartbeat: blockingHeartbeat },
      lcpMs: Math.round(q.lcp || 0),
      fcpMs: fcp ? Math.round(fcp.startTime) : null,
      cls: Math.round((q.cls || 0) * 10000) / 10000,
      topShifts: q.shifts.sort((a, b) => b.value - a.value).slice(0, 5),
      longTasks: q.longTasks.length,
      blockingTimeMs: Math.round(blocking),
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      loadMs: nav ? Math.round(nav.loadEventEnd) : null,
      requests: res.length + 1,
      transferKB: Math.round((res.reduce((s, r) => s + (r.transferSize || 0), 0) + ((nav && nav.transferSize) || 0)) / 1024),
    };
  });

  // ---- DOM hygiene ----
  const dom = await page.evaluate(() => {
    const describe = (el) => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += `#${el.id}`;
      if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
      return s;
    };
    const brokenImages = [...document.images]
      .filter((i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src))
      .map((i) => ({ el: describe(i), src: (i.currentSrc || i.src).slice(0, 120) }));
    const imagesWithoutDimensions = [...document.images]
      .filter((i) => !(i.getAttribute('width') && i.getAttribute('height')) && !/\d/.test(getComputedStyle(i).aspectRatio))
      .slice(0, 10)
      .map((i) => ({ el: describe(i), src: (i.currentSrc || i.src || '').slice(0, 80) }));
    const failedFonts = [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family);
    const anchors = [...document.querySelectorAll('a[href^="#"]')];
    const brokenAnchors = anchors
      .filter((a) => {
        const h = a.getAttribute('href');
        if (!h || h === '#') return false;
        let id = h.slice(1);
        try { id = decodeURIComponent(id); } catch {}
        return !document.getElementById(id) && !document.getElementsByName(id).length;
      })
      .map((a) => ({ el: describe(a), href: a.getAttribute('href') }));
    const placeholderLinks = anchors.filter((a) => a.getAttribute('href') === '#').length;
    const meta = (n) => document.querySelector(`meta[name="${n}"]`);
    return {
      brokenImages,
      imagesWithoutDimensions,
      failedFonts,
      brokenAnchors,
      placeholderLinks,
      hygiene: {
        lang: document.documentElement.lang || null,
        title: document.title || null,
        metaViewport: Boolean(meta('viewport')),
        metaDescription: Boolean(meta('description')),
      },
    };
  });

  // ---- keyboard traversal ----
  const keyboard = { stops: 0, trapAt: null, hiddenFocus: [], focusableCount: 0, note: '' };
  keyboard.focusableCount = await page.evaluate(() => {
    const sel = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary';
    return [...document.querySelectorAll(sel)].filter((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    }).length;
  });
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  let last = '';
  let repeat = 0;
  for (let i = 0; i < MAX_TABS; i++) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      let key = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + '|' + Math.round(r.left) + ',' + Math.round(r.top);
      return {
        key,
        el: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''),
        text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30),
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0',
      };
    });
    if (!s) break;
    keyboard.stops++;
    if (!s.visible) keyboard.hiddenFocus.push({ el: s.el, text: s.text });
    if (s.key === last) {
      repeat++;
      if (repeat >= 2) { keyboard.trapAt = { el: s.el, text: s.text }; break; }
    } else {
      repeat = 0;
      last = s.key;
    }
  }
  if (keyboard.stops === 0) keyboard.note = 'Tab did not focus anything.';
  else if (keyboard.stops < keyboard.focusableCount && !keyboard.trapAt) keyboard.note = `Tab reached ${keyboard.stops} of ${keyboard.focusableCount} focusable elements (lead: elements inside closed menus or modals are expected to be skipped).`;

  // ---- click smoke test ----
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  let candidates = await markCandidates(page);
  const clicks = [];
  for (const c of candidates) {
    const before = await stateHash(page);
    const errBefore = consoleErrors.length + pageErrors.length;
    const urlBefore = page.url();
    const loc = page.locator(`[data-qa-idx="${c.idx}"]`).first();
    const result = { ...c };
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 1500 });
      await loc.click({ timeout: 2500 });
    } catch (e) {
      const lines = String(e.message).split('\n').map((l) => l.trim()).filter(Boolean);
      // The useful reason (for example "<div> intercepts pointer events") is usually not on the first line.
      const reason = lines.find((l) => /intercepts pointer events|not visible|not stable|not enabled|outside of the viewport/i.test(l));
      result.problem = 'click failed: ' + lines[0].slice(0, 100) + (reason && reason !== lines[0] ? ' | ' + reason.slice(0, 160) : '');
      clicks.push(result);
      await page.keyboard.press('Escape').catch(() => {});
      continue;
    }
    await page.waitForTimeout(350);
    if (page.url().split('#')[0] !== urlBefore.split('#')[0]) {
      result.navigated = page.url().slice(0, 120);
      await page.goto(url, { waitUntil: 'load' }).catch(() => {});
      await markCandidates(page);
    } else {
      const after = await stateHash(page);
      if (after === before && !c.alreadyActive) result.noObservableEffect = true;
    }
    const newErrors = consoleErrors.length + pageErrors.length - errBefore;
    if (newErrors > 0) result.newErrors = newErrors;
    clicks.push(result);
    await page.keyboard.press('Escape').catch(() => {});
  }

  await context.close();

  const issues = [];
  if (perf.lcpMs > THRESHOLDS.lcpMs) issues.push(`LCP ${perf.lcpMs}ms > ${THRESHOLDS.lcpMs}ms`);
  if (perf.cls > THRESHOLDS.cls) issues.push(`CLS ${perf.cls} > ${THRESHOLDS.cls}`);
  if (perf.blockingTimeMs > THRESHOLDS.blockingTimeMs) issues.push(`blocking time ${perf.blockingTimeMs}ms > ${THRESHOLDS.blockingTimeMs}ms`);
  if (consoleErrors.length || pageErrors.length) issues.push(`${consoleErrors.length + pageErrors.length} console/page errors`);
  if (failedRequests.length || badStatus.length) issues.push(`${failedRequests.length + badStatus.length} failed requests`);
  if (dom.brokenImages.length) issues.push(`${dom.brokenImages.length} broken images`);
  if (dom.brokenAnchors.length) issues.push(`${dom.brokenAnchors.length} broken #anchors`);
  if (keyboard.trapAt) issues.push('keyboard trap');
  if (keyboard.hiddenFocus.length) issues.push(`${keyboard.hiddenFocus.length} focus stops on hidden elements`);
  const clickProblems = clicks.filter((c) => c.problem || c.newErrors).length;
  if (clickProblems) issues.push(`${clickProblems} clicks failed or caused errors`);

  return {
    profile: { name, ...p },
    performance: perf,
    errors: { console: consoleErrors.slice(0, 10), page: pageErrors.slice(0, 10), failedRequests: failedRequests.slice(0, 10), badStatus: badStatus.slice(0, 10), dialogs },
    thirdPartyOrigins: [...thirdParty].slice(0, 15),
    ...dom,
    keyboard,
    clicks: { tested: clicks.length, results: clicks.filter((c) => c.problem || c.noObservableEffect || c.navigated || c.newErrors) },
    issues,
  };
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
// Warm-up: the first page in a fresh browser sometimes loses long-task entries.
// A throwaway page with a short busy loop makes later measurements stable.
{
  const warmContext = await browser.newContext();
  const warm = await warmContext.newPage();
  await warm.setContent('<!doctype html><title>warm</title><script>const t=Date.now();while(Date.now()-t<120){}</script>');
  await warm.waitForTimeout(300);
  await warmContext.close();
}
const report = {
  url,
  capturedAt: new Date().toISOString(),
  thresholds: THRESHOLDS,
  note: 'Lab data: single run on this machine, no network throttling, mobile profile has 4x CPU throttling. Entries under clicks.results with noObservableEffect are leads, not verdicts.',
  profiles: {},
};
for (const [name, p] of Object.entries(PROFILES)) {
  report.profiles[name] = await runProfile(browser, name, p);
}
await browser.close();
await writeFile(join(outDir, 'qa.json'), JSON.stringify(report, null, 2));

for (const [name, r] of Object.entries(report.profiles)) {
  const pf = r.performance;
  console.log(
    `${name.padEnd(7)} LCP:${pf.lcpMs}ms CLS:${pf.cls} blocking:${pf.blockingTimeMs}ms requests:${pf.requests} ` +
    `clicks:${r.clicks.tested} tabStops:${r.keyboard.stops}  issues: ${r.issues.length ? r.issues.join('; ') : 'none'}`,
  );
}
console.log(`Saved to ${join(outDir, 'qa.json')}`);
