// Tarot of Today: frontend controller (vanilla JS, no build step)

const SPREAD_SIZE = 21;
const REVERSED_CHANCE = 0.35;
const REQUEST_TIMEOUT_MS = 30000;
const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI'];
// Traditional playing-card lineage: wands→clubs, cups→hearts, swords→spades, pentacles→diamonds
const SUIT_GLYPH = { wands: '♣', cups: '♥', swords: '♠', pentacles: '♦' };
const MAJOR_GLYPHS = ['☉', '☽', '✶', '♄', '♃', '♀', '♂', '☿', '✷', '♆', '✺'];
const COURT = { page: 'U', knight: 'Şv', queen: 'Kç', king: 'Kr' };
const ORIENTATION_LABEL = { upright: 'düz', reversed: 'ters' };
const LOADING_LINES = [
  'Ruhlara danışılıyor…',
  'Kozmik çamaşırlar karıştırılıyor…',
  'Merkür’e yine retroda mı diye soruluyor…',
  'Kristal küre yükleniyor…',
  'Gelmiş geçmiş bütün dizilerle çapraz kontrol yapılıyor…',
  'Aşırı dramatik bir hayaletle pazarlık ediliyor…',
  'Üçüncü göz parlatılıyor…',
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
  takeBtn: $('#take-btn'),
  takeBtnLabel: $('#take-btn-label'),
  stock: $('#sticker-stock'),
};

const state = {
  deck: [],
  spread: [],
  selected: [],
  busy: false,
  currentStage: 'intro',
  loaderTimer: null,
  stickerId: null,
  taking: false,
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
    numeral = typeof card.rank === 'number' ? (card.rank === 1 ? 'As' : String(card.rank)) : COURT[card.rank];
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
        attrs: { type: 'button', 'data-index': String(i), 'aria-pressed': 'false', 'aria-label': `Kapalı kart ${i + 1}` },
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
  btn.setAttribute('aria-label', `Seçilen kart ${state.selected.length}`);
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
  if (!res.ok) throw new Error(data.error || `İstek başarısız oldu (${res.status})`);
  return data;
}

function renderDrawn(draw) {
  els.drawn.replaceChildren(
    ...draw.map((entry, i) => {
      const item = el('div', { class: 'drawn__item' }, [
        tarotCard(entry),
        el('div', { class: 'drawn__label' }, [
          el('span', { class: 'drawn__name', text: entry.card.name }),
          el('span', { class: `pill${entry.orientation === 'reversed' ? ' pill--reversed' : ''}`, text: ORIENTATION_LABEL[entry.orientation] || entry.orientation }),
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
    if (data.source !== 'llm') {
      console.warn(`[Fallback Debug] Fallback triggered! Source: "${data.source}", Type: "${data.fallback_type || 'unknown'}"`, {
        fallback_type: data.fallback_type,
        fallback_reason: data.fallback_reason,
        source: data.source,
        category: data.category_id,
        sticker: data.sticker?.id,
      });
    } else {
      console.log('[Fallback Debug] Normal LLM reading received (no fallback).');
    }
    await showResult(data);
  } catch (err) {
    stopLoader();
    els.errorText.textContent =
      err.name === 'TimeoutError' ? 'Ruhlar cevap vermekte çok gecikti. Tekrar deneyelim mi?' : `${err.message} Tekrar deneyelim mi?`;
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
  els.credit.textContent = who || 'Özgün çıkartma';
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
  resetTakeButton(data.sticker.id, data.sticker_remaining);
  if (data.exhausted_categories?.length) console.info('[Stok] Tükenen kategoriler:', data.exhausted_categories);
  els.result.hidden = false;

  const sentenceCount = els.readingText.children.length;
  await wait(sentenceCount * 650 + 500);
  els.sticker.classList.add('is-in');
  await wait(1100);
  els.result.classList.add('is-done');
  (els.takeBtn.disabled ? els.replayBtn : els.takeBtn).focus({ preventScroll: true });
}

/* ---------------- Sticker stock ---------------- */
function renderStock(remaining) {
  if (typeof remaining !== 'number') {
    els.stock.textContent = '';
    return;
  }
  els.stock.textContent = remaining > 0 ? `Kalan: ${remaining}` : 'Tükendi';
  els.stock.classList.toggle('is-low', remaining > 0 && remaining <= 5);
  els.stock.classList.toggle('is-out', remaining === 0);
}

function resetTakeButton(stickerId, remaining) {
  state.stickerId = stickerId;
  els.takeBtn.classList.remove('is-taken', 'is-out');
  els.takeBtn.disabled = remaining === 0;
  els.takeBtnLabel.textContent = remaining === 0 ? 'Tükendi' : "Sticker'ı al!";
  renderStock(remaining);
}

function logInventory(data) {
  console.groupCollapsed(`[Stok] ${data.sticker_id} → kalan ${data.remaining} · toplam ${data.total_remaining}`);
  console.table(data.stock.map(({ id, character, category_label, remaining, disabled }) => ({ id, character, kategori: category_label, kalan: remaining, devre_dışı: disabled })));
  console.table(data.categories);
  console.groupEnd();
}

async function takeSticker() {
  if (!state.stickerId || state.taking || els.takeBtn.disabled) return;
  state.taking = true;
  els.takeBtn.disabled = true;
  try {
    const res = await fetch(`/api/stickers/${encodeURIComponent(state.stickerId)}/take`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (data.stock) logInventory(data);
    if (res.status === 409) {
      els.takeBtn.classList.add('is-out');
      els.takeBtnLabel.textContent = 'Tükendi';
      renderStock(0);
      return;
    }
    if (!res.ok) throw new Error(data.error || `İstek başarısız oldu (${res.status})`);
    els.takeBtn.classList.add('is-taken');
    els.takeBtnLabel.textContent = 'Alındı! ✓';
    renderStock(data.remaining);
  } catch (err) {
    console.error('[Stok] Sticker alınamadı:', err);
    els.takeBtn.disabled = false;
    els.takeBtnLabel.textContent = 'Tekrar dene';
  } finally {
    state.taking = false;
  }
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
  els.takeBtn.addEventListener('click', takeSticker);
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
    els.startBtn.textContent = 'Deste bulunamadı. Tekrar denemek için sayfayı yenile';
  }
}

boot();
