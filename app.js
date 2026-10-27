'use strict';

// ---------- Настройки ----------
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NEW_PER_DAY = 15;          // новых карточек в день на каждую азбуку (умный порядок)
const LEARN_AHEAD = 20 * MIN;    // показать изучаемую карточку чуть раньше, если больше нечего
const WEAK_SESSION = 10;         // карточек в круге «Учить слабые»
const CORRECT_DELAY = 520;       // мс зелёного состояния во вкладке «Ввод»
const MILESTONES = [5, 10, 15, 20, 30, 40, 50, 75, 100];
const STORE_KEY = 'kana-cards-v1';

const RATINGS = [
  { value: 1, label: 'Плохо',  tone: 'bad' },
  { value: 2, label: 'Норм',   tone: 'hard' },
  { value: 3, label: 'Хорошо', tone: 'good' },
  { value: 4, label: 'Легко',  tone: 'easy' },
];
// Сколько «помнит» каждая оценка: из этого считается сила запоминания.
const RATING_SCORE = { 1: 0, 2: 0.45, 3: 0.8, 4: 1 };

const LEVELS = {
  mastered: { label: 'Выучено', tone: 'easy' },
  good:     { label: 'Хорошо',  tone: 'good' },
  learning: { label: 'Учу',     tone: 'hard' },
  weak:     { label: 'Слабо',   tone: 'bad' },
  new:      { label: 'Новая',   tone: 'muted' },
};
const SCRIPT_NAMES = { hiragana: 'Хирагана', katakana: 'Катакана', both: 'Обе' };
const ORDERS = {
  smart:  { label: 'Умный',      short: 'умный', hint: 'Сначала то, что пора повторить. Новые знаки — по 15 в день.' },
  seq:    { label: 'По порядку', short: 'по порядку',    hint: 'あいうえお → かきくけこ → …' },
  random: { label: 'Вразброс',   short: 'вразброс',      hint: 'Каждый раунд — в случайном порядке.' },
};
const ROW_NAMES = ['a', 'ka', 'sa', 'ta', 'na', 'ha', 'ma', 'ya', 'ra', 'wa', 'n'];
const ALL_ROWS = ROW_NAMES.map((_, i) => i);

const ROW_OF = {};
GRID.forEach((row, i) => row.forEach((romaji) => { if (romaji) ROW_OF[romaji] = i; }));

const CARDS = ['hiragana', 'katakana'].flatMap((script) =>
  KANA.map((k, i) => ({
    id: script[0] + ':' + k.romaji, script, order: i, row: ROW_OF[k.romaji], romaji: k.romaji, ...k[script],
  }))
);
const CARD_BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));
const ROW_FIRST = ALL_ROWS.map((r) => KANA.find((k) => ROW_OF[k.romaji] === r));

// ---------- Хранилище (только в этом браузере) ----------
function defaults() {
  return {
    cards: {}, days: {}, newDay: { date: '', count: {}, extra: {} },
    script: 'hiragana', tab: 'cards', best: {},
    filter: { rows: ALL_ROWS.slice(), order: 'smart' },
  };
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    if (d && d.cards) {
      const merged = { ...defaults(), ...d };
      if (!merged.filter || !Array.isArray(merged.filter.rows) || !merged.filter.rows.length) merged.filter = defaults().filter;
      if (!ORDERS[merged.filter.order]) merged.filter.order = 'smart';
      return merged;
    }
  } catch (e) {}
  return defaults();
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) {}
}
let db = load();

// ---------- Мелкие помощники ----------
const todayKey = (d = new Date()) => d.toLocaleDateString('sv');
const st = (id) => db.cards[id];
const seenCard = (c) => !!(st(c.id) && st(c.id).reps);
const scriptsOf = (script) => (script === 'both' ? ['hiragana', 'katakana'] : [script]);
const scriptPool = () => CARDS.filter((c) => scriptsOf(db.script).includes(c.script));
const filteredPool = () => {
  const rows = new Set(db.filter.rows);
  return scriptPool().filter((c) => rows.has(c.row));
};
const plural = (n, [one, few, many]) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function newDay() {
  if (db.newDay.date !== todayKey()) db.newDay = { date: todayKey(), count: {}, extra: {} };
  return db.newDay;
}
const newLeft = (script) => {
  const nd = newDay();
  return NEW_PER_DAY + (nd.extra[script] || 0) - (nd.count[script] || 0);
};

// ---------- Интервальные повторения ----------
// Упрощённый алгоритм в духе Anki: новая карточка проходит шаги 1 и 10 минут,
// потом интервал растёт в днях. «Плохо» возвращает карточку в начало.
function schedule(prev, rating, now) {
  const s = { ease: 2.5, ivl: 0, step: 0, reps: 0, lapses: 0, wrong: 0, score: null, due: 0, ...prev };
  s.reps += 1;
  s.last = now;
  const v = RATING_SCORE[rating];
  s.score = s.score === null ? v : s.score * 0.6 + v * 0.4;
  if (rating === 1) s.wrong += 1;

  if (s.ivl === 0) {
    if (rating === 1) { s.step = 0; s.due = now + MIN; }
    else if (rating === 2) { s.due = now + (s.step === 0 ? 6 : 10) * MIN; }
    else if (rating === 3) {
      s.step += 1;
      if (s.step >= 2) { s.ivl = 1; s.step = 0; s.due = now + DAY; }
      else s.due = now + 10 * MIN;
    } else { s.ivl = 4; s.step = 0; s.due = now + 4 * DAY; }
    return s;
  }

  if (rating === 1) {
    s.lapses += 1;
    s.ease = Math.max(1.3, s.ease - 0.2);
    s.ivl = 0;
    s.step = 0;
    s.due = now + MIN;
    return s;
  }
  if (rating === 2) { s.ease = Math.max(1.3, s.ease - 0.15); s.ivl = Math.max(s.ivl + 1, s.ivl * 1.2); }
  else if (rating === 3) s.ivl = Math.max(s.ivl + 1, s.ivl * s.ease);
  else { s.ivl = Math.max(s.ivl + 1, s.ivl * s.ease * 1.3); s.ease += 0.15; }
  s.ivl = Math.round(s.ivl);
  s.due = now + s.ivl * DAY;
  return s;
}

function levelOf(s) {
  if (!s || !s.reps) return 'new';
  if (s.score < 0.4) return 'weak';
  if (s.score < 0.65) return 'learning';
  if (s.score >= 0.85 && s.reps >= 3) return 'mastered';
  return 'good';
}

function fmtInterval(ms) {
  const m = Math.round(ms / MIN);
  if (m < 60) return Math.max(1, m) + ' мин';
  const h = Math.round(ms / HOUR);
  if (h < 24) return h + ' ч';
  const d = Math.round(ms / DAY);
  if (d < 30) return d + ' д';
  return Math.round(d / 30) + ' мес';
}

function record(card, rating, countAsNew) {
  const prev = st(card.id);
  if (countAsNew && !(prev && prev.reps)) {
    const nd = newDay();
    nd.count[card.script] = (nd.count[card.script] || 0) + 1;
  }
  db.cards[card.id] = schedule(prev, rating, Date.now());
  const t = todayKey();
  db.days[t] = (db.days[t] || 0) + 1;
  save();
}

function weakest(limit) {
  return scriptPool()
    .filter(seenCard)
    .sort((a, b) => {
      const sa = st(a.id), sb = st(b.id);
      return sa.score - sb.score || sb.lapses - sa.lapses || sb.wrong - sa.wrong;
    })
    .slice(0, limit);
}

function dayStreak() {
  const d = new Date();
  if (!db.days[todayKey(d)]) d.setDate(d.getDate() - 1);
  let n = 0;
  while (db.days[todayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function rowsSummary() {
  const rows = db.filter.rows;
  if (rows.length === ALL_ROWS.length) return 'Все строки';
  const script = db.script === 'katakana' ? 'katakana' : 'hiragana';
  if (rows.length <= 3) return rows.map((r) => ROW_FIRST[r][script].char).join(' · ');
  return rows.length + ' ' + plural(rows.length, ['строка', 'строки', 'строк']);
}
const filterSummary = () => rowsSummary() + ' · ' + ORDERS[db.filter.order].short;

// ---------- Элементы ----------
const $ = (id) => document.getElementById(id);
const el = {
  tabs: [...document.querySelectorAll('[data-tab]')],
  scripts: document.querySelectorAll('[data-script]'),
  views: { cards: $('view-cards'), type: $('view-type'), progress: $('view-progress') },
  filterBtn: $('filterBtn'), filterBadge: $('filterBadge'),
  cardsInfo: $('cardsInfo'), scene: $('scene'), flashcard: $('flashcard'), front: $('front'), back: $('back'),
  doneBox: $('doneBox'), rateBar: $('rateBar'),
  typeCard: $('typeCard'), typeKana: $('typeKana'), typeTag: $('typeTag'), input: $('answer'),
  typeFeedback: $('typeFeedback'), typeFilter: $('typeFilter'), tStreak: $('tStreak'), tBest: $('tBest'), tAcc: $('tAcc'),
  statTiles: $('statTiles'), levelBar: $('levelBar'), levelLegend: $('levelLegend'),
  weakList: $('weakList'), weakBtn: $('weakBtn'), grids: $('grids'),
  sheet: $('sheet'), sheetBody: $('sheetBody'), fx: $('fx'), announcer: $('announcer'),
};

const ANIMS = ['anim-card-in', 'anim-rise', 'anim-pop', 'anim-shake', 'anim-bump', 'exit-bad', 'exit-hard', 'exit-good', 'exit-easy'];
function restartAnim(node, cls) {
  node.classList.remove(...ANIMS);
  void node.offsetWidth;
  if (cls) node.classList.add(cls);
}

// ---------- Эффекты: лепестки, +1, тосты ----------
const PETAL_COLORS = ['--sakura', '--sakura', '--primary', '--hard', '--easy', '--good'];

function burst(x, y, count = 16, power = 1) {
  if (reduceMotion.matches) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'petal' + (Math.random() < 0.3 ? ' spark' : '');
    const angle = Math.random() * Math.PI * 2;
    const dist = (60 + Math.random() * 120) * power;
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    p.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
    p.style.setProperty('--dy', Math.sin(angle) * dist * 0.75 + 50 * power + 'px');
    p.style.setProperty('--r', Math.random() * 540 - 270 + 'deg');
    p.style.setProperty('--s', 7 + Math.random() * 7 + 'px');
    p.style.setProperty('--d', 750 + Math.random() * 500 + 'ms');
    p.style.setProperty('--c', `var(${PETAL_COLORS[i % PETAL_COLORS.length]})`);
    frag.appendChild(p);
    setTimeout(() => p.remove(), 1400);
  }
  el.fx.appendChild(frag);
}

function burstFrom(node, count, power) {
  const r = node.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, count, power);
}

function plusOne(node) {
  if (reduceMotion.matches) return;
  const r = node.getBoundingClientRect();
  const s = document.createElement('span');
  s.className = 'plus-one';
  s.textContent = '+1';
  s.style.left = r.left + r.width / 2 + 'px';
  s.style.top = r.top - 4 + 'px';
  el.fx.appendChild(s);
  setTimeout(() => s.remove(), 950);
}

function toast(text) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1900);
}

function milestone(streak, node) {
  if (!MILESTONES.includes(streak) && !(streak > 100 && streak % 50 === 0)) return;
  toast(`🔥 ${streak} подряд!`);
  burstFrom(node, 42, 1.6);
}

// ---------- Оборот карточки ----------
const ICON_BULB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/></svg>';
const ICON_BOOK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5z"/><path d="M4 19a2 2 0 0 1 2-2h13"/></svg>';
const ICON_TAP = '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2M21 12a9 9 0 0 1-15.5 6.2"/><path d="M18.5 2v4h-4M5.5 22v-4h4"/></svg>';

function backHTML(card, titleId) {
  const w = card.word;
  const marked = w.kana.split(card.char).join('<mark>' + card.char + '</mark>');
  const alts = ALTERNATES[card.romaji];
  return `
    <div class="flex items-center justify-between">
      <span class="chip plain on-dark">${SCRIPT_NAMES[card.script]}</span>
      <span class="chip plain on-dark font-display tracking-wide">${ROW_NAMES[card.row]}-ряд</span>
    </div>
    <div class="flex flex-1 flex-col items-center justify-center py-1 text-center">
      <span class="font-kana text-[clamp(2.25rem,6vh,3rem)] font-semibold leading-none" lang="ja">${card.char}</span>
      <span class="mt-3 text-[.6875rem] font-semibold uppercase tracking-[.16em] text-white/90">звучит как</span>
      <span ${titleId ? `id="${titleId}"` : ''} class="mt-1 font-display text-[clamp(3.25rem,10vh,5rem)] font-bold leading-none tracking-tight">${card.romaji}</span>
      ${alts ? `<span class="mt-2 text-sm text-white/90">также пишут: <b class="font-display font-semibold">${alts.join(', ')}</b></span>` : ''}
    </div>
    <section class="glass">
      <div class="glass-label">${ICON_BULB} Как запомнить</div>
      <p class="mt-1.5 text-[1rem] leading-snug">${card.hint}</p>
    </section>
    <section class="glass flex items-center gap-3.5">
      <div class="sound-ring text-[2.25rem] leading-none" aria-hidden="true">${w.emoji}</div>
      <div class="min-w-0">
        <div class="glass-label">${ICON_BOOK} Пример</div>
        <div class="mt-1 font-kana text-[1.75rem] font-semibold leading-tight" lang="ja">${marked}</div>
        <div class="text-[.9375rem]"><span class="font-display text-[.8125rem] font-medium tracking-wide">${w.romaji}</span> — ${w.ru}</div>
      </div>
    </section>`;
}

// =====================================================================
// Карточки
// =====================================================================
// round: колода по фильтру (по порядку/вразброс), слабые или трудные.
// Без round работает умный порядок (интервальные повторения).
const session = { ready: false, round: null, current: null, revealed: false, busy: false, combo: 0 };

const makeRound = (ids, kind) => ({ ids, total: ids.length, first: {}, kind });
function deckRound() {
  const ids = filteredPool().map((c) => c.id);
  if (db.filter.order === 'random') shuffle(ids);
  return makeRound(ids, 'deck');
}
function resetCards() {
  Object.assign(session, { ready: false, round: null, current: null, revealed: false, busy: false });
}

function nextCard() {
  if (session.round) return session.round.ids.length ? CARD_BY_ID[session.round.ids[0]] : null;

  const now = Date.now();
  const pool = filteredPool();
  const avoid = session.current && session.current.id;
  const seen = pool.filter(seenCard);
  const byDue = (a, b) => st(a.id).due - st(b.id).due;

  const due = seen.filter((c) => st(c.id).due <= now).sort(byDue);
  const fresh = pool.filter((c) => !seenCard(c) && newLeft(c.script) > 0);
  const soon = seen.filter((c) => st(c.id).due > now && st(c.id).due <= now + LEARN_AHEAD).sort(byDue);

  return due.find((c) => c.id !== avoid)
    || fresh[0]
    || soon.find((c) => c.id !== avoid)
    || due[0] || soon[0] || null;
}

function queueCounts() {
  const now = Date.now();
  const pool = filteredPool();
  let fresh = 0, learn = 0, review = 0;
  for (const script of scriptsOf(db.script)) {
    const unseen = pool.filter((c) => c.script === script && !seenCard(c)).length;
    fresh += Math.max(0, Math.min(unseen, newLeft(script)));
  }
  for (const c of pool) {
    const s = st(c.id);
    if (!s || !s.reps) continue;
    if (s.ivl === 0 && s.due <= now + LEARN_AHEAD) learn++;
    else if (s.ivl > 0 && s.due <= now) review++;
  }
  return { fresh, learn, review };
}

function renderCardsInfo() {
  const r = session.round;
  let left;
  if (r && r.kind !== 'deck') {
    left = `<span class="chip tone-bad">${r.kind === 'weak' ? 'Слабые карточки' : 'Трудные из раунда'}</span>
      <button type="button" data-act="exit" class="min-h-[36px] px-1 text-sm font-medium text-muted hover:text-ink">Выйти</button>`;
  } else {
    left = `<button type="button" data-act="filter" class="min-h-[36px] truncate rounded-full px-1 text-left text-sm font-medium text-muted hover:text-ink">${filterSummary()}</button>`;
  }

  let right;
  if (r) {
    const done = r.total - new Set(r.ids).size;
    const pct = r.total ? Math.round((done / r.total) * 100) : 0;
    right = `<span class="flex shrink-0 items-center gap-2 tabular-nums">
        <span class="meter tone-primary w-16 sm:w-24"><span style="width:${pct}%"></span></span>
        <b class="font-display text-[.8125rem] font-semibold">${done}/${r.total}</b>
      </span>`;
  } else {
    const q = queueCounts();
    right = `<span class="flex shrink-0 items-center gap-3 tabular-nums">
        <span class="text-muted" title="новые">новые <b class="font-display font-semibold text-primary">${q.fresh}</b></span>
        <span class="text-muted" title="изучаются">учу <b class="font-display font-semibold text-bad">${q.learn}</b></span>
        <span class="text-muted" title="пора повторить">повтор <b class="font-display font-semibold text-good">${q.review}</b></span>
      </span>`;
  }
  el.cardsInfo.innerHTML = `<span class="flex min-w-0 items-center gap-2">${left}</span>${right}`;
}

function renderRateBar() {
  const card = session.current;
  const now = Date.now();
  el.rateBar.style.visibility = card ? 'visible' : 'hidden';
  el.rateBar.innerHTML = RATINGS.map((r) => {
    const ivl = card ? fmtInterval(schedule(st(card.id), r.value, now).due - now) : '';
    return `<button type="button" class="rate tone-${r.tone}" data-rate="${r.value}" ${session.revealed ? '' : 'disabled'}
        aria-label="${r.label}, вернётся через ${ivl}">
        <kbd class="hidden sm:block" aria-hidden="true">${r.value}</kbd><span>${r.label}</span><small aria-hidden="true">${ivl}</small>
      </button>`;
  }).join('');
}

function setCardLabel() {
  const c = session.current;
  if (!c) return;
  const flipped = el.flashcard.classList.contains('is-flipped');
  el.flashcard.setAttribute('aria-label', flipped
    ? `${c.char} — ${c.romaji}. Пример: ${c.word.kana}, ${c.word.ru}. Нажмите, чтобы вернуть лицевую сторону`
    : `Карточка ${c.char}. Нажмите, чтобы увидеть ответ`);
}

function renderCard(card, animate = true) {
  const lv = LEVELS[levelOf(st(card.id))];
  el.front.innerHTML = `
    <div class="flex items-center justify-between">
      <span class="chip plain tone-primary">${SCRIPT_NAMES[card.script]}</span>
      <span class="chip tone-${lv.tone}">${lv.label}</span>
    </div>
    <div class="flex flex-1 items-center justify-center">
      <div class="genko"><span class="glyph font-kana" lang="ja">${card.char}</span></div>
    </div>
    <p class="flex items-center justify-center gap-1.5 text-sm font-medium text-muted">${ICON_TAP} Нажми, чтобы перевернуть</p>`;
  el.back.innerHTML = backHTML(card);
  el.back.scrollTop = 0;

  // Сбросить переворот без анимации, затем показать новую карточку.
  el.flashcard.classList.add('no-anim');
  el.flashcard.classList.remove('is-flipped');
  void el.flashcard.offsetWidth;
  el.flashcard.classList.remove('no-anim');
  restartAnim(el.scene, animate ? 'anim-card-in' : null);
  setCardLabel();
}

function chipCount(tone, label, n) {
  return `<span class="chip tone-${tone}">${label} <b class="font-display">${n}</b></span>`;
}

function renderDone() {
  el.scene.classList.add('hidden');
  el.doneBox.classList.remove('hidden');
  el.doneBox.classList.add('flex');

  const r = session.round;
  let html;
  if (r) {
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    Object.values(r.first).forEach((v) => counts[v]++);
    const hard = Object.keys(r.first).filter((id) => r.first[id] <= 2);
    const good = counts[3] + counts[4];
    const share = r.total ? good / r.total : 0;
    html = `
      <div class="text-5xl" aria-hidden="true">${share >= 0.7 ? '🎉' : '💪'}</div>
      <h2 class="mt-4 font-display text-xl font-semibold">${r.kind === 'deck' ? 'Раунд пройден' : 'Круг пройден'}</h2>
      <p class="mt-2 text-muted">С первого раза: ${good} из ${r.total}. Карточки с «Плохо» возвращались, пока не запомнились.</p>
      <div class="mt-4 flex flex-wrap justify-center gap-1.5">
        ${chipCount('bad', 'Плохо', counts[1])}${chipCount('hard', 'Норм', counts[2])}${chipCount('good', 'Хорошо', counts[3])}${chipCount('easy', 'Легко', counts[4])}
      </div>
      <div class="mt-6 flex w-full flex-col gap-2">
        <button type="button" class="btn btn-primary" data-act="again">Ещё раунд</button>
        ${hard.length ? `<button type="button" class="btn btn-soft" data-act="hard">Только трудные · ${hard.length}</button>` : ''}
        ${r.kind !== 'deck' ? '<button type="button" class="btn btn-soft" data-act="exit">К выбранным строкам</button>' : ''}
      </div>`;
    if (share >= 0.7) requestAnimationFrame(() => burstFrom(el.doneBox, 46, 1.8));
  } else {
    const now = Date.now();
    const pool = filteredPool();
    const upcoming = pool.filter(seenCard).map((c) => st(c.id).due).sort((a, b) => a - b)[0];
    const unseen = pool.some((c) => !seenCard(c));
    const anySeen = scriptPool().some(seenCard);
    html = `
      <div class="text-5xl" aria-hidden="true">🌸</div>
      <h2 class="mt-4 font-display text-xl font-semibold">На сегодня всё</h2>
      <p class="mt-2 text-muted">${upcoming ? 'Следующая карточка через ' + fmtInterval(upcoming - now) + '.' : 'Все карточки пройдены.'}</p>
      <div class="mt-6 flex w-full flex-col gap-2">
        ${anySeen ? '<button type="button" class="btn btn-primary" data-act="weak">Учить слабые</button>' : ''}
        ${unseen ? '<button type="button" class="btn btn-soft" data-act="more">Ещё 10 новых</button>' : ''}
        <button type="button" class="btn btn-soft" data-act="filter">Пройти по порядку или вразброс</button>
      </div>`;
  }
  el.doneBox.innerHTML = html;
  restartAnim(el.doneBox, 'anim-card-in');
}

function showNext() {
  const card = nextCard();
  session.current = card;
  session.revealed = false;
  renderCardsInfo();
  renderRateBar();
  if (!card) return renderDone();
  el.doneBox.classList.add('hidden');
  el.doneBox.classList.remove('flex');
  el.scene.classList.remove('hidden');
  renderCard(card);
}

function enterCards() {
  if (!session.ready) {
    session.ready = true;
    session.round = db.filter.order === 'smart' ? null : deckRound();
    session.current = null;
  }
  if (!session.current) return showNext();
  session.revealed = false;
  renderCardsInfo();
  renderRateBar();
  renderCard(session.current, false);
}

function flip() {
  if (!session.current || session.busy) return;
  const flipped = el.flashcard.classList.toggle('is-flipped');
  if (flipped && !session.revealed) {
    session.revealed = true;
    renderRateBar();
  }
  setCardLabel();
}

function rate(value) {
  const card = session.current;
  if (!card || !session.revealed || session.busy) return;
  session.busy = true;
  const btn = el.rateBar.querySelector(`[data-rate="${value}"]`);
  if (btn) btn.classList.add('is-picked');

  record(card, value, !session.round);
  const r = session.round;
  if (r) {
    r.ids.shift();
    if (!(card.id in r.first)) r.first[card.id] = value;
    // «Плохо» — карточка вернётся через пару других.
    if (value === 1) r.ids.splice(Math.min(3, r.ids.length), 0, card.id);
  }

  if (value >= 3) {
    session.combo++;
    burstFrom(el.scene, value === 4 ? 30 : 16, value === 4 ? 1.35 : 1);
    milestone(session.combo, el.scene);
  } else if (value === 1) {
    session.combo = 0;
  }

  const finish = () => {
    restartAnim(el.scene, null);
    session.busy = false;
    showNext();
  };
  if (reduceMotion.matches) return finish();
  restartAnim(el.scene, { 1: 'exit-bad', 2: 'exit-hard', 3: 'exit-good', 4: 'exit-easy' }[value]);
  setTimeout(finish, value === 4 ? 300 : 260);
}

function startWeak() {
  const ids = weakest(WEAK_SESSION).map((c) => c.id);
  if (!ids.length) return;
  Object.assign(session, { ready: true, round: makeRound(ids, 'weak'), current: null });
  closeSheet();
  setTab('cards');
}

function exitRound() {
  resetCards();
  enterCards();
}

function cardsAction(act) {
  const r = session.round;
  if (act === 'weak') startWeak();
  else if (act === 'exit') exitRound();
  else if (act === 'filter') openFilter();
  else if (act === 'again') {
    if (r && r.kind === 'weak') return startWeak();
    session.round = deckRound();
    session.current = null;
    showNext();
  } else if (act === 'hard' && r) {
    let ids = Object.keys(r.first).filter((id) => r.first[id] <= 2);
    if (db.filter.order === 'random') shuffle(ids);
    else ids.sort((a, b) => CARDS.indexOf(CARD_BY_ID[a]) - CARDS.indexOf(CARD_BY_ID[b]));
    session.round = makeRound(ids, 'hard');
    session.current = null;
    showNext();
  } else if (act === 'more') {
    const nd = newDay();
    for (const s of scriptsOf(db.script)) nd.extra[s] = (nd.extra[s] || 0) + 10;
    save();
    showNext();
  }
}

el.flashcard.addEventListener('click', flip);
el.rateBar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-rate]');
  if (b) rate(Number(b.dataset.rate));
});
[el.doneBox, el.cardsInfo].forEach((node) => node.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (act) cardsAction(act.dataset.act);
}));

// =====================================================================
// Ввод ромадзи
// =====================================================================
const typing = { current: null, phase: 'idle', recent: [], bag: [], index: 0, streak: 0, seen: 0, correct: 0, timer: null };

function resetTyping() {
  Object.assign(typing, { current: null, recent: [], bag: [], index: 0 });
}

function normalize(value) {
  return value
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
    .toLowerCase();
}
const isCorrect = (card, answer) => answer === card.romaji || (ALTERNATES[card.romaji] || []).includes(answer);

function pickTyping() {
  const pool = filteredPool();
  const order = db.filter.order;
  if (order === 'seq') {
    const c = pool[typing.index % pool.length];
    typing.index++;
    return c;
  }
  if (order === 'random') {
    if (!typing.bag.length) {
      typing.bag = shuffle(pool.map((c) => c.id));
      // Не начинать новый круг с того же знака, что был последним.
      const last = typing.bag.length - 1;
      if (typing.current && last > 0 && typing.bag[last] === typing.current.id) [typing.bag[0], typing.bag[last]] = [typing.bag[last], typing.bag[0]];
    }
    return CARD_BY_ID[typing.bag.pop()];
  }
  // Умный: слабые и новые знаки выпадают чаще.
  const avoid = Math.min(3, pool.length - 1);
  const options = pool.filter((c) => !typing.recent.includes(c.id));
  const weight = (c) => { const s = st(c.id); return s && s.reps ? 0.4 + (1 - s.score) * 3 : 1; };
  const total = options.reduce((sum, c) => sum + weight(c), 0);
  let r = Math.random() * total;
  let chosen = options[options.length - 1];
  for (const c of options) { r -= weight(c); if (r <= 0) { chosen = c; break; } }
  typing.recent.push(chosen.id);
  while (typing.recent.length > avoid) typing.recent.shift();
  return chosen;
}

function renderTypeStats(bump) {
  el.typeFilter.innerHTML = `<button type="button" data-act="filter" class="min-h-[36px] truncate text-left font-medium hover:text-ink">${filterSummary()}</button>`;
  el.tStreak.textContent = typing.streak;
  el.tBest.textContent = db.best[db.script] || 0;
  el.tAcc.textContent = typing.seen ? Math.round((typing.correct / typing.seen) * 100) + '%' : '–';
  if (bump) restartAnim(el.tStreak, 'anim-bump');
}

function hintButton(html, action) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mt-1 min-h-[40px] px-2 text-sm text-muted hover:text-ink transition';
  b.innerHTML = html;
  b.addEventListener('click', (e) => { e.stopPropagation(); action(); el.input.focus(); });
  return b;
}

function setTypeFeedback(kind, card, typed) {
  const f = el.typeFeedback;
  f.innerHTML = '';
  if (kind === 'ask') {
    f.appendChild(hintButton('Не помнишь? <kbd class="key">Пробел</kbd> или нажми сюда', revealTyping));
  } else if (kind === 'right') {
    f.innerHTML = `<p class="anim-pop font-display text-xl font-semibold text-good">✓ ${card.romaji}</p>`;
  } else {
    f.innerHTML = `
      <p class="anim-rise text-[11px] font-semibold uppercase tracking-[.16em] text-muted">${typed ? 'Правильный ответ' : 'Ответ'}</p>
      <p class="anim-rise font-display text-3xl font-bold leading-tight text-bad">${card.romaji}</p>`;
    f.appendChild(hintButton('<kbd class="key">Enter</kbd> дальше', nextTyping));
  }
}

function nextTyping() {
  clearTimeout(typing.timer);
  typing.current = pickTyping();
  typing.phase = 'ask';
  el.typeCard.classList.remove('is-ok', 'is-bad');
  el.input.classList.remove('is-ok', 'is-bad');
  el.input.readOnly = false;
  el.input.value = '';
  el.typeKana.textContent = typing.current.char;
  el.typeTag.textContent = db.script === 'both' ? SCRIPT_NAMES[typing.current.script] : '';
  restartAnim(el.typeKana, 'anim-rise');
  setTypeFeedback('ask');
  el.input.focus();
}

function typingRight() {
  const card = typing.current;
  typing.phase = 'right';
  typing.seen++;
  typing.correct++;
  typing.streak++;
  if (typing.streak > (db.best[db.script] || 0)) db.best[db.script] = typing.streak;
  record(card, 3, false);
  el.typeCard.classList.add('is-ok');
  el.input.classList.add('is-ok');
  el.input.readOnly = true;
  restartAnim(el.typeCard, 'anim-pop');
  burstFrom(el.typeCard, 18, 1.1);
  plusOne(el.tStreak);
  setTypeFeedback('right', card);
  renderTypeStats(true);
  milestone(typing.streak, el.typeCard);
  typing.timer = setTimeout(nextTyping, CORRECT_DELAY);
}

function typingWrong(typed) {
  const card = typing.current;
  typing.phase = 'wrong';
  typing.seen++;
  typing.streak = 0;
  record(card, 1, false);
  el.typeCard.classList.add('is-bad');
  if (typed) el.input.classList.add('is-bad');
  el.input.readOnly = true;
  restartAnim(el.typeCard, 'anim-shake');
  setTypeFeedback('wrong', card, typed);
  renderTypeStats(false);
}

function checkTyping() {
  if (typing.phase === 'right' || typing.phase === 'wrong') return nextTyping();
  if (typing.phase !== 'ask') return;
  const answer = normalize(el.input.value);
  if (!answer) return restartAnim(el.input, 'anim-shake');
  isCorrect(typing.current, answer) ? typingRight() : typingWrong(answer);
}

function revealTyping() {
  if (typing.phase === 'ask') typingWrong('');
  else nextTyping();
}

function enterTyping() {
  typing.streak = typing.seen = typing.correct = 0;
  renderTypeStats(false);
  nextTyping();
}

el.input.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Enter') { e.preventDefault(); checkTyping(); }
  else if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); revealTyping(); }
});
// Некоторые мобильные клавиатуры не сообщают о пробеле в keydown.
el.input.addEventListener('input', () => {
  if (/\s/.test(el.input.value)) {
    el.input.value = el.input.value.replace(/\s+/g, '');
    revealTyping();
  }
});
$('typeStage').addEventListener('click', () => el.input.focus());
el.typeFilter.addEventListener('click', (e) => { if (e.target.closest('[data-act="filter"]')) openFilter(); });

// =====================================================================
// Прогресс
// =====================================================================
function renderProgress() {
  const pool = scriptPool();
  const counts = { mastered: 0, good: 0, learning: 0, weak: 0, new: 0 };
  for (const c of pool) counts[levelOf(st(c.id))]++;
  const known = counts.mastered + counts.good;

  const tile = (value, label) => `
    <div class="panel !p-3.5">
      <div class="font-display text-[1.6rem] font-bold leading-none tabular-nums">${value}</div>
      <div class="mt-1.5 text-xs font-medium text-muted">${label}</div>
    </div>`;
  const streak = dayStreak();
  el.statTiles.innerHTML =
    tile(known + '<span class="text-sm font-medium text-muted">/' + pool.length + '</span>', 'знаю') +
    tile(streak + (streak ? '<span class="text-lg"> 🔥</span>' : ''), plural(streak, ['день подряд', 'дня подряд', 'дней подряд'])) +
    tile(db.days[todayKey()] || 0, 'повторов сегодня');

  el.levelBar.innerHTML = Object.keys(LEVELS)
    .filter((k) => counts[k])
    .map((k) => `<span class="tone-${LEVELS[k].tone}" style="width:${(counts[k] / pool.length) * 100}%;background:rgb(var(--tone)${k === 'new' ? ' / .25' : ''})" title="${LEVELS[k].label}: ${counts[k]}"></span>`)
    .join('');
  el.levelLegend.innerHTML = Object.keys(LEVELS).map((k) => `
    <span class="inline-flex items-center gap-1.5 tone-${LEVELS[k].tone}">
      <span class="h-2.5 w-2.5 rounded-full" style="background:rgb(var(--tone))" aria-hidden="true"></span>${LEVELS[k].label} <b class="font-display font-semibold text-ink tabular-nums">${counts[k]}</b>
    </span>`).join('');

  const weak = weakest(5);
  el.weakList.innerHTML = weak.length
    ? weak.map((c) => {
        const s = st(c.id);
        const lv = LEVELS[levelOf(s)];
        return `
          <li>
            <button type="button" data-card="${c.id}" class="flex min-h-[44px] w-full items-center gap-3 rounded-xl px-1 text-left hover:bg-surface2">
              <span class="w-9 text-center font-kana text-2xl font-semibold" lang="ja">${c.char}</span>
              <span class="w-10 font-display text-xs font-medium text-muted">${c.romaji}</span>
              <span class="meter flex-1 tone-${lv.tone}"><span style="width:${Math.max(6, Math.round(s.score * 100))}%"></span></span>
              <span class="w-16 text-right text-xs text-muted tabular-nums">${s.wrong} ${plural(s.wrong, ['ошибка', 'ошибки', 'ошибок'])}</span>
            </button>
          </li>`;
      }).join('')
    : '<li class="text-sm text-muted">Пока пусто. Пройдите несколько карточек — здесь появятся знаки, которые запоминаются хуже всего.</li>';

  const n = weakest(WEAK_SESSION).length;
  el.weakBtn.disabled = n === 0;
  el.weakBtn.textContent = n ? `Учить слабые · ${n}` : 'Учить слабые';

  el.grids.innerHTML = scriptsOf(db.script).map((script) => `
    <div class="panel">
      <h2 class="mb-3 font-display text-[.95rem] font-semibold">${SCRIPT_NAMES[script]}</h2>
      <div class="grid grid-cols-5 gap-1.5 sm:gap-2">
        ${GRID.flat().map((romaji) => {
          if (!romaji) return '<span></span>';
          const c = CARD_BY_ID[script[0] + ':' + romaji];
          const lv = LEVELS[levelOf(st(c.id))];
          return `<button type="button" class="tile tone-${lv.tone}" data-card="${c.id}" aria-label="${c.char}, ${c.romaji}: ${lv.label}">
              <span class="dot"></span><span class="k" lang="ja">${c.char}</span><span class="r">${c.romaji}</span>
            </button>`;
        }).join('')}
      </div>
    </div>`).join('');
}

el.weakBtn.addEventListener('click', startWeak);
el.views.progress.addEventListener('click', (e) => {
  const b = e.target.closest('[data-card]');
  if (b) openCardSheet(CARD_BY_ID[b.dataset.card], b);
});
$('resetBtn').addEventListener('click', () => {
  if (!confirm('Сбросить весь прогресс на этом устройстве? Это нельзя отменить.')) return;
  db = { ...defaults(), script: db.script, tab: db.tab, filter: db.filter };
  save();
  resetCards();
  resetTyping();
  typing.streak = typing.seen = typing.correct = 0;
  renderProgress();
});

// =====================================================================
// Шторка
// =====================================================================
let sheetReturnFocus = null;
let sheetHandler = null;
// Фокус возвращаем на кнопку-открывашку только при работе с клавиатуры:
// иначе пробел после клика мышью снова откроет шторку вместо переворота карточки.
let keyboardUser = false;
document.addEventListener('keydown', () => { keyboardUser = true; }, true);
document.addEventListener('pointerdown', () => { keyboardUser = false; }, true);

function openSheet(html, from, handler) {
  el.sheetBody.innerHTML = html;
  sheetHandler = handler || null;
  sheetReturnFocus = from || document.activeElement;
  el.sheet.hidden = false;
  const first = el.sheet.querySelector('[data-autofocus]') || el.sheet.querySelector('button');
  if (first) first.focus();
}

function closeSheet() {
  if (el.sheet.hidden) return;
  el.sheet.hidden = true;
  el.sheetBody.innerHTML = '';
  sheetHandler = null;
  if (keyboardUser && sheetReturnFocus && sheetReturnFocus.isConnected) sheetReturnFocus.focus();
  else if (document.activeElement) document.activeElement.blur();
}

function trapFocus(e) {
  const items = [...el.sheet.querySelectorAll('button:not([disabled]), [tabindex="0"]')];
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

el.sheet.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheet();
  else if (sheetHandler) sheetHandler(e);
});

function openCardSheet(card, from) {
  const s = st(card.id);
  const lv = LEVELS[levelOf(s)];
  const now = Date.now();
  const row = (k, v) => `<div class="flex min-h-[40px] items-center justify-between text-sm"><span class="text-muted">${k}</span><span class="font-medium">${v}</span></div>`;
  openSheet(`
    <div class="face back back-static rounded-[1.5rem]">${backHTML(card, 'sheetTitle')}</div>
    <div class="mt-3 divide-y divide-line px-1">
      ${row('Уровень', `<span class="chip tone-${lv.tone}">${lv.label}</span>`)}
      ${row('Показов', s ? s.reps : 0)}
      ${row('Ошибок', s ? s.wrong : 0)}
      ${row('Следующий повтор', !s || !s.reps ? '—' : s.due <= now ? 'сейчас' : 'через ' + fmtInterval(s.due - now))}
    </div>
    <button type="button" class="btn btn-soft mt-3 w-full" data-close data-autofocus>Закрыть</button>`, from);
}

// ---------- Фильтр: строки и порядок ----------
function openFilter() {
  const draft = { rows: new Set(db.filter.rows), order: db.filter.order };
  const script = db.script === 'katakana' ? 'katakana' : 'hiragana';
  const perRow = (r) => GRID[r].filter(Boolean).length * scriptsOf(db.script).length;

  openSheet(`
    <h2 id="sheetTitle" class="font-display text-lg font-semibold">Что учить</h2>
    <p class="mt-1 text-sm text-muted">Для вкладок «Карточки» и «Ввод». «Прогресс» всегда показывает все знаки.</p>

    <div class="mt-5 flex items-center justify-between">
      <h3 class="text-sm font-semibold">Строки</h3>
      <button type="button" data-allrows class="min-h-[40px] px-2 text-sm font-semibold text-primary"></button>
    </div>
    <div class="mt-1 grid grid-cols-4 gap-2 sm:grid-cols-6">
      ${ALL_ROWS.map((r) => `
        <button type="button" class="row-chip" data-row="${r}" aria-label="Строка ${ROW_NAMES[r]}">
          <span class="k" lang="ja">${ROW_FIRST[r][script].char}</span><span class="r">${ROW_NAMES[r]}</span>
        </button>`).join('')}
    </div>

    <h3 class="mt-5 text-sm font-semibold">Порядок</h3>
    <div class="mt-2 flex flex-col gap-2" role="radiogroup" aria-label="Порядок">
      ${Object.entries(ORDERS).map(([key, o]) => `
        <button type="button" class="opt" role="radio" data-order="${key}">
          <span class="dot" aria-hidden="true"></span>
          <span class="min-w-0">
            <span class="block font-semibold">${o.label}</span>
            <span class="block text-xs text-muted">${o.hint}</span>
          </span>
        </button>`).join('')}
    </div>

    <div class="mt-5 grid grid-cols-[auto_1fr] gap-2">
      <button type="button" class="btn btn-soft" data-close>Отмена</button>
      <button type="button" class="btn btn-primary" data-apply></button>
    </div>`, el.filterBtn, onClick);

  const body = el.sheetBody;
  const sync = () => {
    body.querySelectorAll('[data-row]').forEach((b) => b.setAttribute('aria-pressed', String(draft.rows.has(Number(b.dataset.row)))));
    body.querySelectorAll('[data-order]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.order === draft.order)));
    const all = draft.rows.size === ALL_ROWS.length;
    body.querySelector('[data-allrows]').textContent = all ? 'Снять все' : 'Выбрать все';
    const n = [...draft.rows].reduce((sum, r) => sum + perRow(r), 0);
    const apply = body.querySelector('[data-apply]');
    apply.disabled = n === 0;
    apply.textContent = n ? `Учить ${n} ${plural(n, ['знак', 'знака', 'знаков'])}` : 'Выберите строку';
  };
  sync();

  function onClick(e) {
    const row = e.target.closest('[data-row]');
    const order = e.target.closest('[data-order]');
    if (row) {
      const r = Number(row.dataset.row);
      draft.rows.has(r) ? draft.rows.delete(r) : draft.rows.add(r);
    } else if (order) {
      draft.order = order.dataset.order;
    } else if (e.target.closest('[data-allrows]')) {
      draft.rows = draft.rows.size === ALL_ROWS.length ? new Set() : new Set(ALL_ROWS);
    } else if (e.target.closest('[data-apply]')) {
      db.filter = { rows: [...draft.rows].sort((a, b) => a - b), order: draft.order };
      save();
      resetCards();
      resetTyping();
      updateFilterBadge();
      closeSheet();
      setTab(db.tab === 'progress' ? 'cards' : db.tab);
      return;
    } else return;
    sync();
  }
}

function updateFilterBadge() {
  const active = db.filter.rows.length !== ALL_ROWS.length || db.filter.order !== 'smart';
  el.filterBadge.hidden = !active;
  el.filterBtn.setAttribute('aria-label', 'Фильтр: ' + filterSummary());
}
el.filterBtn.addEventListener('click', openFilter);

// =====================================================================
// Вкладки, азбука, тема, клавиатура
// =====================================================================
function setTab(tab) {
  db.tab = tab;
  save();
  el.tabs.forEach((b) => {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  for (const [name, view] of Object.entries(el.views)) {
    view.classList.toggle('hidden', name !== tab);
    view.classList.toggle('flex', name === tab);
  }
  clearTimeout(typing.timer);
  if (tab === 'cards') enterCards();
  else if (tab === 'type') enterTyping();
  else renderProgress();
}

function setScript(script) {
  db.script = script;
  save();
  el.scripts.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.script === script)));
  resetCards();
  resetTyping();
  updateFilterBadge();
  setTab(db.tab);
}

el.tabs.forEach((b) => b.addEventListener('click', (e) => {
  if (e.detail > 0) b.blur();   // клик мышью: пробел дальше переворачивает карточку
  setTab(b.dataset.tab);
}));
// Стрелки переключают вкладки (шаблон WAI-ARIA tabs).
document.querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const i = el.tabs.findIndex((b) => b.dataset.tab === db.tab);
  const next = el.tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + el.tabs.length) % el.tabs.length];
  setTab(next.dataset.tab);
  next.focus();
});
el.scripts.forEach((b) => b.addEventListener('click', () => { b.blur(); setScript(b.dataset.script); }));

$('themeBtn').addEventListener('click', (e) => {
  e.currentTarget.blur();
  const dark = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem('kana-theme', dark ? 'dark' : 'light'); } catch (err) {}
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!el.sheet.hidden) {
    if (e.key === 'Escape') closeSheet();
    else if (e.key === 'Tab') trapFocus(e);
    return;
  }
  if (db.tab === 'cards') {
    const onControl = e.target.closest && e.target.closest('button, a, input') && e.target !== el.flashcard;
    if ((e.key === ' ' || e.key === 'Enter') && !onControl) { e.preventDefault(); flip(); }
    else if (['1', '2', '3', '4'].includes(e.key)) rate(Number(e.key));
  } else if (db.tab === 'type' && e.target !== el.input && (e.key.length === 1 || e.key === 'Enter') && !e.target.closest('button')) {
    el.input.focus();
  }
});

setScript(['hiragana', 'katakana', 'both'].includes(db.script) ? db.script : 'hiragana');
