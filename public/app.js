// Tarot of Today: frontend controller (vanilla JS, no build step)

const SPREAD_SIZE = 21;
const REVERSED_CHANCE = 0.35;
const REQUEST_TIMEOUT_MS = 30000;
const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI'];
// Traditional playing-card lineage: wands→clubs, cups→hearts, swords→spades, pentacles→diamonds
const SUIT_GLYPH = { wands: '♣', cups: '♥', swords: '♠', pentacles: '♦' };
const MAJOR_GLYPHS = ['☉', '☽', '✶', '♄', '♃', '♀', '♂', '☿', '✷', '♆', '✺'];
const COURT = { page: 'P', knight: 'Kn', queen: 'Q', king: 'K' };
const LOADING_LINES = [
  'Consulting the spirits…',
  'Shuffling the cosmic laundry…',
  'Asking Mercury if it’s in retrograde again…',
  'The crystal ball is buffering…',
  'Cross-referencing with every sitcom ever…',
  'Negotiating with a very dramatic ghost…',
  'Polishing the third eye…',
];

const $ = (sel) => document.querySelector(sel);
const els = {
  root: document.documentElement,
  motionToggle: $('#motion-toggle'),
  startBtn: $('#start-btn'),
  stages: { intro: $('#stage-intro'), pick: $('#stage-pick'), reading: $('#stage-reading') },
  spread: $('#spread'),
  slots: [...document.querySelectorAll('.slot')],
  drawn: $('#drawn'),
  loader: $('#loader'),
  loaderText: $('#loader-text'),
  error: $('#error'),
  errorText: $('#error-text'),
  retryBtn: $('#retry-btn'),
  errorNewBtn: $('#error-new-btn'),
  result: $('#result'),
  readingText: $('#reading-text'),
  sticker: $('#sticker'),
  stickerImg: $('#sticker-img'),
  stickerFallback: $('#sticker-fallback'),
  stickerFallbackText: $('#sticker-fallback-text'),
  badge: $('#category-badge'),
  credit: $('#sticker-credit'),
  replayBtn: $('#replay-btn'),
};

const state = {
  deck: [],
  spread: [],
  selected: [],
  busy: false,
  currentStage: 'intro',
  loaderTimer: null,
};

/* ---------------- Utilities ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () => els.root.classList.contains('reduce-motion');
const wait = (ms) => sleep(reducedMotion() ? 0 : ms);

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') Object.assign(node.style, v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

async function showStage(name) {
  if (state.currentStage === name) return;
  const prev = els.stages[state.currentStage];
  prev.classList.add('is-leaving');
  await wait(420);
  prev.classList.remove('is-leaving');
  prev.hidden = true;
  prev.classList.remove('is-active');
  const next = els.stages[name];
  next.hidden = false;
  next.classList.add('is-active');
  state.currentStage = name;
  window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

/* ---------------- Reduced motion ---------------- */
function initMotionPreference() {
  const stored = localStorage.getItem('reduceMotion');
  const osPrefers = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setReducedMotion(stored === null ? osPrefers : stored === 'true');
  els.motionToggle.addEventListener('click', () => {
    const next = !reducedMotion();
    setReducedMotion(next);
    localStorage.setItem('reduceMotion', String(next));
  });
}
function setReducedMotion(on) {
  els.root.classList.toggle('reduce-motion', on);
  els.root.classList.toggle('motion-ok', !on);
  els.motionToggle.setAttribute('aria-pressed', String(on));
}

/* ---------------- Card rendering ---------------- */
function cardArt(card, orientation) {
  let numeral;
  let glyph;
  if (card.arcana === 'major') {
    numeral = ROMAN[card.rank] ?? '';
    glyph = MAJOR_GLYPHS[card.rank % MAJOR_GLYPHS.length];
  } else {
    numeral = typeof card.rank === 'number' ? (card.rank === 1 ? 'A' : String(card.rank)) : COURT[card.rank];
    glyph = SUIT_GLYPH[card.suit];
  }
  return el('div', { class: `card-art${orientation === 'reversed' ? ' is-reversed' : ''}` }, [
    el('span', { class: 'card-art__numeral', text: numeral }),
    el('span', { class: 'card-art__glyph', text: glyph, 'aria-hidden': 'true' }),
    el('span', { class: 'card-art__name', text: card.name }),
  ]);
}

function tarotCard({ card, orientation }, { tag = 'div', attrs = {} } = {}) {
  return el(tag, { class: 'tarot-card', ...attrs }, [
    el('div', { class: 'tarot-card__inner' }, [
      el('div', { class: 'tarot-card__face tarot-card__back' }),
      el('div', { class: 'tarot-card__face tarot-card__front', 'data-suit': card.suit || 'major' }, [cardArt(card, orientation)]),
    ]),
  ]);
}

/* ---------------- Picking ---------------- */
function dealSpread() {
  state.spread = shuffle(state.deck)
    .slice(0, SPREAD_SIZE)
    .map((card) => ({ card, orientation: Math.random() < REVERSED_CHANCE ? 'reversed' : 'upright' }));
  state.selected = [];
  els.spread.classList.remove('is-locked');
  els.spread.replaceChildren(
    ...state.spread.map((entry, i) => {
      const btn = tarotCard(entry, {
        tag: 'button',
        attrs: { type: 'button', 'data-index': String(i), 'aria-pressed': 'false', 'aria-label': `Face-down card ${i + 1}` },
      });
      btn.style.setProperty('--i', i);
      btn.style.setProperty('--tilt', `${(Math.random() * 6 - 3).toFixed(2)}deg`);
      return btn;
    })
  );
  els.slots.forEach((s) => s.classList.remove('is-filled'));
}

function onSpreadClick(e) {
  const btn = e.target.closest('.tarot-card');
  if (!btn || state.busy || btn.disabled) return;
  const idx = Number(btn.dataset.index);
  if (state.selected.includes(idx)) return; // no duplicates
  state.selected.push(idx);
  btn.classList.add('is-selected');
  btn.dataset.order = String(state.selected.length);
  btn.setAttribute('aria-pressed', 'true');
  btn.setAttribute('aria-label', `Selected card ${state.selected.length}`);
  btn.disabled = true;
  els.slots[state.selected.length - 1].classList.add('is-filled');

  if (state.selected.length === 3) {
    state.busy = true;
    els.spread.classList.add('is-locked');
    els.spread.querySelectorAll('.tarot-card').forEach((b) => (b.disabled = true));
    startReading();
  }
}

/* ---------------- Reading flow ---------------- */
function currentDraw() {
  return state.selected.map((i) => state.spread[i]);
}

async function requestReading(draw) {
  const res = await fetch('/api/generate-reading', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cards: draw.map((d) => ({ id: d.card.id, orientation: d.orientation })) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function renderDrawn(draw) {
  els.drawn.replaceChildren(
    ...draw.map((entry, i) => {
      const item = el('div', { class: 'drawn__item' }, [
        tarotCard(entry),
        el('div', { class: 'drawn__label' }, [
          el('span', { class: 'drawn__name', text: entry.card.name }),
          el('span', { class: `pill${entry.orientation === 'reversed' ? ' pill--reversed' : ''}`, text: entry.orientation }),
        ]),
      ]);
      item.style.setProperty('--i', i);
      return item;
    })
  );
}

async function flipDrawn() {
  const items = [...els.drawn.querySelectorAll('.drawn__item')];
  await wait(500);
  for (const item of items) {
    item.querySelector('.tarot-card').classList.add('is-flipped');
    item.classList.add('is-revealed');
    await wait(650);
  }
  await wait(300);
}

function startLoader() {
  els.loader.hidden = false;
  let i = 0;
  els.loaderText.textContent = LOADING_LINES[0];
  clearInterval(state.loaderTimer);
  state.loaderTimer = setInterval(() => {
    i = (i + 1) % LOADING_LINES.length;
    els.loaderText.textContent = LOADING_LINES[i];
  }, 1800);
}
function stopLoader() {
  clearInterval(state.loaderTimer);
  els.loader.hidden = true;
}

async function startReading() {
  const draw = currentDraw();
  await wait(650);
  await showStage('reading');
  els.result.hidden = true;
  els.result.classList.remove('is-done');
  els.error.hidden = true;
  renderDrawn(draw);

  // Request runs in parallel with the flip animation.
  const pending = requestReading(draw);
  pending.catch(() => {}); // handled below; avoid unhandled-rejection noise during flips
  await flipDrawn();
  await fetchAndShow(pending);
}

async function fetchAndShow(pending) {
  state.busy = true;
  startLoader();
  try {
    const data = await pending;
    stopLoader();
    await showResult(data);
  } catch (err) {
    stopLoader();
    els.errorText.textContent =
      err.name === 'TimeoutError' ? 'The spirits took too long to answer. Shall we try again?' : `${err.message}. Shall we try again?`;
    els.error.hidden = false;
  } finally {
    state.busy = false;
  }
}

function splitSentences(text) {
  return text.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) || [text];
}

function setSticker(sticker) {
  const who = [sticker.character, sticker.franchise].filter(Boolean).join(' · ');
  els.stickerFallback.hidden = true;
  els.stickerImg.hidden = false;
  els.stickerImg.alt = sticker.character ? `${sticker.character}: ${sticker.visual_description}` : sticker.visual_description;
  els.stickerImg.onerror = () => {
    els.stickerImg.hidden = true;
    els.stickerFallbackText.textContent = sticker.visual_description;
    els.stickerFallback.hidden = false;
  };
  els.stickerImg.src = sticker.asset_path;
  els.credit.textContent = who || 'Original sticker';
}

async function showResult(data) {
  // Use canonical names from the server for the labels.
  data.cards.forEach((c, i) => {
    const name = els.drawn.querySelectorAll('.drawn__name')[i];
    if (name) name.textContent = c.name;
  });

  els.readingText.replaceChildren(
    ...splitSentences(data.reading_text).map((s, i) => {
      const span = el('span', { class: 'sentence', text: s });
      span.style.setProperty('--i', i);
      return span;
    })
  );
  els.badge.textContent = data.category_label;
  els.sticker.classList.remove('is-in');
  setSticker(data.sticker);
  els.result.hidden = false;

  const sentenceCount = els.readingText.children.length;
  await wait(sentenceCount * 650 + 500);
  els.sticker.classList.add('is-in');
  await wait(1100);
  els.result.classList.add('is-done');
  els.replayBtn.focus({ preventScroll: true });
}

async function newDraw() {
  if (state.busy && state.currentStage === 'reading') return;
  state.busy = false;
  dealSpread();
  await showStage('pick');
}

/* ---------------- Boot ---------------- */
async function boot() {
  initMotionPreference();
  els.spread.addEventListener('click', onSpreadClick);
  els.startBtn.addEventListener('click', newDraw);
  els.replayBtn.addEventListener('click', newDraw);
  els.errorNewBtn.addEventListener('click', newDraw);
  els.retryBtn.addEventListener('click', () => {
    if (state.busy) return;
    els.error.hidden = true;
    fetchAndShow(requestReading(currentDraw()));
  });

  try {
    const res = await fetch('/api/deck');
    if (!res.ok) throw new Error();
    state.deck = (await res.json()).cards;
    els.startBtn.disabled = false;
  } catch {
    els.startBtn.textContent = 'The deck is missing. Refresh to try again';
  }
}

boot();
