'use strict';

// ---------- Настройки ----------
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NEW_PER_DAY = 15;          // новых карточек в день на каждую азбуку
const LEARN_AHEAD = 20 * MIN;    // показать изучаемую карточку чуть раньше, если больше нечего
const WEAK_SESSION = 10;         // карточек в режиме «Учить слабые»
const CORRECT_DELAY = 450;       // мс зелёного состояния во вкладке «Ввод»
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

const CARDS = ['hiragana', 'katakana'].flatMap((script) =>
  KANA.map((k) => ({ id: script[0] + ':' + k.romaji, script, romaji: k.romaji, ru: k.ru, ...k[script] }))
);
const CARD_BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));

// ---------- Хранилище (только в этом браузере) ----------
function defaults() {
  return { cards: {}, days: {}, newDay: { date: '', count: {}, extra: {} }, script: 'hiragana', tab: 'cards', best: {} };
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    if (d && d.cards) return { ...defaults(), ...d };
  } catch (e) {}
  return defaults();
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) {}
}
let db = load();

const todayKey = (d = new Date()) => d.toLocaleDateString('sv');
const st = (id) => db.cards[id];
const poolFor = (script) => (script === 'both' ? CARDS : CARDS.filter((c) => c.script === script));
const scriptsOf = (script) => (script === 'both' ? ['hiragana', 'katakana'] : [script]);

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

function weakest(script, limit) {
  return poolFor(script)
    .filter((c) => st(c.id) && st(c.id).reps)
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

// ---------- Элементы ----------
const $ = (id) => document.getElementById(id);
const el = {
  tabs: document.querySelectorAll('[data-tab]'),
  scripts: document.querySelectorAll('[data-script]'),
  views: { cards: $('view-cards'), type: $('view-type'), progress: $('view-progress') },
  cardsInfo: $('cardsInfo'), scene: $('scene'), flashcard: $('flashcard'), front: $('front'), back: $('back'),
  doneBox: $('doneBox'), rateBar: $('rateBar'),
  typeCard: $('typeCard'), typeKana: $('typeKana'), typeTag: $('typeTag'), input: $('answer'),
  typeFeedback: $('typeFeedback'), tStreak: $('tStreak'), tBest: $('tBest'), tAcc: $('tAcc'),
  statTiles: $('statTiles'), levelBar: $('levelBar'), levelLegend: $('levelLegend'),
  weakList: $('weakList'), weakBtn: $('weakBtn'), grids: $('grids'),
  sheet: $('sheet'), sheetBody: $('sheetBody'),
};

function restartAnim(node, cls) {
  node.classList.remove('anim-card-in', 'anim-rise', 'anim-pop', 'anim-shake', 'anim-bump');
  void node.offsetWidth;
  node.classList.add(cls);
}

// Обратная сторона: перевод, чтение по-русски, ассоциация, пример.
function backHTML(card, titleId) {
  const w = card.word;
  const marked = w.kana.split(card.char).join('<mark>' + card.char + '</mark>');
  return `<div class="my-auto">
    <div class="flex items-center gap-4">
      <span class="font-kana text-[clamp(4rem,9vh,5.5rem)] leading-none" lang="ja">${card.char}</span>
      <div class="min-w-0">
        <div ${titleId ? `id="${titleId}"` : ''} class="text-[clamp(2.75rem,6vh,3.5rem)] font-bold leading-none tracking-tight">${card.romaji}</div>
        <div class="mt-2 text-base opacity-90">по-русски: «${card.ru}»</div>
      </div>
    </div>
    <div class="my-5 h-px bg-white/20"></div>
    <p class="label">Как запомнить</p>
    <p class="mt-2 text-[1.15rem] leading-snug">${card.hint}</p>
    <p class="label mt-6">Пример</p>
    <div class="mt-2 flex items-center gap-3.5 rounded-2xl bg-white/15 p-4">
      <span class="text-[2.75rem] leading-none" aria-hidden="true">${w.emoji}</span>
      <div class="min-w-0">
        <div class="font-kana text-[2.1rem] leading-tight" lang="ja">${marked}</div>
        <div class="text-sm opacity-90">${w.romaji} — ${w.ru}</div>
      </div>
    </div></div>`;
}

// =====================================================================
// Карточки
// =====================================================================
const session = { current: null, revealed: false, weak: null };

function nextCard() {
  if (session.weak) return session.weak.length ? CARD_BY_ID[session.weak[0]] : null;

  const now = Date.now();
  const pool = poolFor(db.script);
  const avoid = session.current && session.current.id;
  const seen = pool.filter((c) => st(c.id) && st(c.id).reps);
  const byDue = (a, b) => st(a.id).due - st(b.id).due;

  const due = seen.filter((c) => st(c.id).due <= now).sort(byDue);
  const fresh = pool.filter((c) => !(st(c.id) && st(c.id).reps) && newLeft(c.script) > 0);
  const soon = seen.filter((c) => st(c.id).due > now && st(c.id).due <= now + LEARN_AHEAD).sort(byDue);

  return due.find((c) => c.id !== avoid)
    || fresh[0]
    || soon.find((c) => c.id !== avoid)
    || due[0] || soon[0] || null;
}

function queueCounts() {
  const now = Date.now();
  const pool = poolFor(db.script);
  let fresh = 0, learn = 0, review = 0;
  for (const script of scriptsOf(db.script)) {
    const unseen = pool.filter((c) => c.script === script && !(st(c.id) && st(c.id).reps)).length;
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
  if (session.weak) {
    el.cardsInfo.innerHTML = `
      <span class="chip tone-bad">Слабые карточки · осталось ${session.weak.length}</span>
      <button type="button" id="exitWeak" class="text-sm font-medium text-muted hover:text-ink">Выйти</button>`;
    $('exitWeak').addEventListener('click', exitWeak);
    return;
  }
  const q = queueCounts();
  el.cardsInfo.innerHTML = `
    <span class="text-muted">новые <b class="font-semibold text-primary">${q.fresh}</b></span>
    <span class="text-muted">учу <b class="font-semibold text-bad">${q.learn}</b></span>
    <span class="text-muted">повтор <b class="font-semibold text-good">${q.review}</b></span>`;
}

function renderRateBar() {
  const card = session.current;
  const now = Date.now();
  el.rateBar.style.visibility = card ? 'visible' : 'hidden';
  el.rateBar.innerHTML = RATINGS.map((r) => {
    const ivl = card ? fmtInterval(schedule(st(card.id), r.value, now).due - now) : '';
    return `<button type="button" class="rate tone-${r.tone}" data-rate="${r.value}" ${session.revealed ? '' : 'disabled'}>
        <kbd class="hidden sm:block">${r.value}</kbd><span>${r.label}</span><small>${ivl}</small>
      </button>`;
  }).join('');
}

function renderCard(card) {
  const lv = LEVELS[levelOf(st(card.id))];
  el.front.innerHTML = `
    <div class="flex items-center justify-between">
      <span class="chip plain tone-primary">${SCRIPT_NAMES[card.script]}</span>
      <span class="chip tone-${lv.tone}">${lv.label}</span>
    </div>
    <div class="flex flex-1 items-center justify-center">
      <div class="glyph-box"><span class="glyph font-kana" lang="ja">${card.char}</span></div>
    </div>
    <p class="text-center text-sm text-muted">Нажми, чтобы перевернуть</p>`;
  el.back.innerHTML = backHTML(card);
  el.back.scrollTop = 0;

  // Сбросить переворот без анимации, затем показать новую карточку.
  el.flashcard.classList.add('no-anim');
  el.flashcard.classList.remove('is-flipped');
  void el.flashcard.offsetWidth;
  el.flashcard.classList.remove('no-anim');
  restartAnim(el.scene, 'anim-card-in');
}

function renderDone() {
  el.scene.classList.add('hidden');
  el.doneBox.classList.remove('hidden');
  el.doneBox.classList.add('flex');

  let html;
  if (session.weak) {
    html = `
      <div class="text-5xl">💪</div>
      <h2 class="mt-4 text-xl font-semibold">Слабые карточки пройдены</h2>
      <p class="mt-2 text-muted">Карточки с оценкой «Плохо» возвращались, пока не запомнились.</p>
      <div class="mt-6 flex w-full flex-col gap-2">
        <button type="button" class="btn btn-primary" data-act="weak">Ещё круг</button>
        <button type="button" class="btn btn-soft" data-act="exit">Обычный режим</button>
      </div>`;
  } else {
    const now = Date.now();
    const pool = poolFor(db.script);
    const upcoming = pool.map((c) => st(c.id)).filter((s) => s && s.reps).map((s) => s.due).sort((a, b) => a - b)[0];
    const unseen = pool.some((c) => !(st(c.id) && st(c.id).reps));
    const anySeen = pool.some((c) => st(c.id) && st(c.id).reps);
    html = `
      <div class="text-5xl">🌸</div>
      <h2 class="mt-4 text-xl font-semibold">На сегодня всё</h2>
      <p class="mt-2 text-muted">${upcoming ? 'Следующая карточка через ' + fmtInterval(upcoming - now) + '.' : 'Все карточки пройдены.'}</p>
      <div class="mt-6 flex w-full flex-col gap-2">
        ${anySeen ? '<button type="button" class="btn btn-primary" data-act="weak">Учить слабые</button>' : ''}
        ${unseen ? '<button type="button" class="btn btn-soft" data-act="more">Ещё 10 новых</button>' : ''}
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

function flip() {
  if (!session.current) return;
  const flipped = el.flashcard.classList.toggle('is-flipped');
  if (flipped && !session.revealed) {
    session.revealed = true;
    renderRateBar();
  }
}

function rate(value) {
  const card = session.current;
  if (!card || !session.revealed) return;
  record(card, value, !session.weak);
  if (session.weak) {
    session.weak.shift();
    // «Плохо» — карточка вернётся через пару других.
    if (value === 1) session.weak.splice(Math.min(2, session.weak.length), 0, card.id);
  }
  showNext();
}

function startWeak() {
  const ids = weakest(db.script, WEAK_SESSION).map((c) => c.id);
  if (!ids.length) return;
  session.weak = ids;
  session.current = null;
  closeSheet();
  setTab('cards');
}

function exitWeak() {
  session.weak = null;
  session.current = null;
  showNext();
}

el.flashcard.addEventListener('click', flip);
el.rateBar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-rate]');
  if (b) rate(Number(b.dataset.rate));
});
el.doneBox.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'weak') startWeak();
  else if (act.dataset.act === 'exit') exitWeak();
  else if (act.dataset.act === 'more') {
    const nd = newDay();
    for (const s of scriptsOf(db.script)) nd.extra[s] = (nd.extra[s] || 0) + 10;
    save();
    showNext();
  }
});

// =====================================================================
// Ввод ромадзи
// =====================================================================
const typing = { current: null, phase: 'idle', recent: [], streak: 0, seen: 0, correct: 0, timer: null };

function normalize(value) {
  return value
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
    .toLowerCase();
}
const isCorrect = (card, answer) => answer === card.romaji || (ALTERNATES[card.romaji] || []).includes(answer);

// Слабые и новые знаки выпадают чаще.
function pickTyping() {
  const pool = poolFor(db.script);
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
  el.tStreak.textContent = typing.streak;
  el.tBest.textContent = db.best[db.script] || 0;
  el.tAcc.textContent = typing.seen ? Math.round((typing.correct / typing.seen) * 100) + '%' : '–';
  if (bump) restartAnim(el.tStreak, 'anim-bump');
}

function hintButton(html, action) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mt-2 text-xs text-muted hover:text-ink transition';
  b.innerHTML = html;
  b.addEventListener('click', (e) => { e.stopPropagation(); action(); el.input.focus(); });
  return b;
}

function setTypeFeedback(kind, card, typed) {
  const f = el.typeFeedback;
  f.innerHTML = '';
  if (kind === 'ask') {
    f.appendChild(hintButton('не помнишь? <kbd class="key">Пробел</kbd> или нажми сюда', revealTyping));
  } else if (kind === 'right') {
    f.innerHTML = `<p class="anim-rise text-lg font-medium text-good">✓ ${card.romaji}</p>`;
  } else {
    f.innerHTML = `
      <p class="anim-rise text-[11px] uppercase tracking-[.2em] text-muted">${typed ? 'правильно' : 'ответ'}</p>
      <p class="anim-rise text-3xl font-semibold leading-tight text-bad">${card.romaji} <span class="text-base font-normal text-muted">«${card.ru}»</span></p>`;
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
  setTypeFeedback('right', card);
  renderTypeStats(true);
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

// =====================================================================
// Прогресс
// =====================================================================
function renderProgress() {
  const pool = poolFor(db.script);
  const counts = { mastered: 0, good: 0, learning: 0, weak: 0, new: 0 };
  for (const c of pool) counts[levelOf(st(c.id))]++;
  const known = counts.mastered + counts.good;

  const tile = (value, label, sub) => `
    <div class="rounded-3xl border border-line bg-surface p-3.5">
      <div class="text-2xl font-bold tabular-nums">${value}</div>
      <div class="mt-0.5 text-xs text-muted">${label}${sub ? ' <span class="opacity-70">' + sub + '</span>' : ''}</div>
    </div>`;
  const streak = dayStreak();
  el.statTiles.innerHTML =
    tile(known + '<span class="text-base font-medium text-muted">/' + pool.length + '</span>', 'знаю') +
    tile(streak + (streak ? ' 🔥' : ''), 'дней подряд') +
    tile(db.days[todayKey()] || 0, 'повторов сегодня');

  el.levelBar.innerHTML = Object.keys(LEVELS)
    .filter((k) => counts[k])
    .map((k) => `<span class="tone-${LEVELS[k].tone}" style="width:${(counts[k] / pool.length) * 100}%;background:rgb(var(--tone)${k === 'new' ? ' / .25' : ''})" title="${LEVELS[k].label}: ${counts[k]}"></span>`)
    .join('');
  el.levelLegend.innerHTML = Object.keys(LEVELS).map((k) => `
    <span class="inline-flex items-center gap-1.5 tone-${LEVELS[k].tone}">
      <span class="h-2 w-2 rounded-full" style="background:rgb(var(--tone))"></span>${LEVELS[k].label} <b class="font-semibold text-ink tabular-nums">${counts[k]}</b>
    </span>`).join('');

  const weak = weakest(db.script, 5);
  el.weakList.innerHTML = weak.length
    ? weak.map((c) => {
        const s = st(c.id);
        const lv = LEVELS[levelOf(s)];
        return `
          <li>
            <button type="button" data-card="${c.id}" class="flex w-full items-center gap-3 text-left">
              <span class="font-kana w-9 text-center text-2xl" lang="ja">${c.char}</span>
              <span class="w-10 text-sm text-muted">${c.romaji}</span>
              <span class="meter flex-1 tone-${lv.tone}"><span style="width:${Math.max(6, Math.round(s.score * 100))}%"></span></span>
              <span class="w-14 text-right text-xs text-muted tabular-nums">ошибок ${s.wrong}</span>
            </button>
          </li>`;
      }).join('')
    : '<li class="text-sm text-muted">Пока пусто. Пройди несколько карточек, и здесь появятся знаки, которые запоминаются хуже всего.</li>';

  const n = Math.min(WEAK_SESSION, weakest(db.script, WEAK_SESSION).length);
  el.weakBtn.disabled = n === 0;
  el.weakBtn.textContent = n ? `Учить слабые · ${n}` : 'Учить слабые';

  el.grids.innerHTML = scriptsOf(db.script).map((script) => `
    <div class="rounded-3xl border border-line bg-surface p-4">
      <h2 class="mb-3 font-semibold">${SCRIPT_NAMES[script]}</h2>
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
  if (b) openSheet(CARD_BY_ID[b.dataset.card], b);
});
$('resetBtn').addEventListener('click', () => {
  if (!confirm('Сбросить весь прогресс на этом устройстве? Это нельзя отменить.')) return;
  db = { ...defaults(), script: db.script, tab: db.tab };
  save();
  session.weak = null;
  session.current = null;
  typing.streak = typing.seen = typing.correct = 0;
  renderProgress();
});

// ---------- Шторка ----------
let sheetReturnFocus = null;

function openSheet(card, from) {
  const s = st(card.id);
  const lv = LEVELS[levelOf(s)];
  const now = Date.now();
  const row = (k, v) => `<div class="flex justify-between py-2 text-sm"><span class="text-muted">${k}</span><span class="font-medium">${v}</span></div>`;
  el.sheetBody.innerHTML = `
    <div class="face back back-static rounded-[1.5rem]">${backHTML(card, 'sheetTitle')}</div>
    <div class="mt-3 divide-y divide-line px-1">
      ${row('Уровень', `<span class="chip tone-${lv.tone}">${lv.label}</span>`)}
      ${row('Показов', s ? s.reps : 0)}
      ${row('Ошибок', s ? s.wrong : 0)}
      ${row('Следующий повтор', !s || !s.reps ? '—' : s.due <= now ? 'сейчас' : 'через ' + fmtInterval(s.due - now))}
    </div>`;
  sheetReturnFocus = from || document.activeElement;
  el.sheet.hidden = false;
  el.sheet.querySelector('button[data-close]').focus();
}

function closeSheet() {
  if (el.sheet.hidden) return;
  el.sheet.hidden = true;
  if (sheetReturnFocus && sheetReturnFocus.isConnected) sheetReturnFocus.focus();
}

el.sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });

// =====================================================================
// Вкладки, азбука, тема, клавиатура
// =====================================================================
function setTab(tab) {
  db.tab = tab;
  save();
  el.tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  for (const [name, view] of Object.entries(el.views)) {
    view.classList.toggle('hidden', name !== tab);
    view.classList.toggle('flex', name === tab);
  }
  clearTimeout(typing.timer);
  if (tab === 'cards') showNext();
  else if (tab === 'type') { typing.streak = typing.seen = typing.correct = 0; renderTypeStats(false); nextTyping(); }
  else renderProgress();
}

function setScript(script) {
  db.script = script;
  save();
  el.scripts.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.script === script)));
  session.weak = null;
  session.current = null;
  typing.recent = [];
  setTab(db.tab);
}

el.tabs.forEach((b) => b.addEventListener('click', () => { b.blur(); setTab(b.dataset.tab); }));
el.scripts.forEach((b) => b.addEventListener('click', () => { b.blur(); setScript(b.dataset.script); }));

$('themeBtn').addEventListener('click', (e) => {
  e.currentTarget.blur();
  const dark = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem('kana-theme', dark ? 'dark' : 'light'); } catch (err) {}
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!el.sheet.hidden) { if (e.key === 'Escape') closeSheet(); return; }
  if (db.tab === 'cards') {
    const onOtherButton = e.target.closest && e.target.closest('button, a') && e.target !== el.flashcard;
    if ((e.key === ' ' || e.key === 'Enter') && !onOtherButton) { e.preventDefault(); flip(); }
    else if (['1', '2', '3', '4'].includes(e.key)) rate(Number(e.key));
  } else if (db.tab === 'type' && e.target !== el.input && (e.key.length === 1 || e.key === 'Enter')) {
    el.input.focus();
  }
});

setScript(['hiragana', 'katakana', 'both'].includes(db.script) ? db.script : 'hiragana');
