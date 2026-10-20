// Synskflicka: Stocks management frontend controller

const state = {
  stickers: [],
  categories: {},
  totalRemaining: 0,
  initialStock: 20,
  searchQuery: '',
  selectedCategory: 'all',
  selectedStatus: 'all',
  saving: new Set(),
};

const els = {
  totalCount: document.getElementById('stat-total'),
  activeCount: document.getElementById('stat-active'),
  disabledCount: document.getElementById('stat-disabled'),
  outCount: document.getElementById('stat-out'),
  categoriesList: document.getElementById('categories-list'),
  categoryTabs: document.getElementById('category-tabs'),
  statusTabs: document.getElementById('status-tabs'),
  searchInput: document.getElementById('search-input'),
  stickerGrid: document.getElementById('sticker-grid'),
  toast: document.getElementById('toast'),
  toastMsg: document.getElementById('toast-msg'),
  toastIcon: document.getElementById('toast-icon'),
  enableAllBtn: document.getElementById('btn-enable-all'),
  disableAllBtn: document.getElementById('btn-disable-all'),
  resetAllBtn: document.getElementById('btn-reset-all'),
  addFiveAllBtn: document.getElementById('btn-add-five-all'),
};

let toastTimeout = null;
function showToast(message, icon = '✓') {
  if (!els.toast) return;
  els.toastMsg.textContent = message;
  els.toastIcon.textContent = icon;
  els.toast.classList.add('is-visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    els.toast.classList.remove('is-visible');
  }, 2600);
}

async function fetchStocks() {
  try {
    const res = await fetch('/api/stocks', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.stickers = data.stock || [];
    state.categories = data.categories || {};
    state.totalRemaining = data.total_remaining ?? 0;
    state.initialStock = data.initialStock ?? 20;
    render();
  } catch (err) {
    console.error('Stok bilgisi alınamadı:', err);
    showToast('Stok bilgisi sunucudan yüklenemedi.', '⚠️');
  }
}

function updateStats() {
  const total = state.stickers.reduce((sum, s) => sum + s.remaining, 0);
  const active = state.stickers.filter((s) => s.enabled && s.remaining > 0).length;
  const disabled = state.stickers.filter((s) => !s.enabled).length;
  const out = state.stickers.filter((s) => s.enabled && s.remaining === 0).length;

  if (els.totalCount) els.totalCount.textContent = total;
  if (els.activeCount) els.activeCount.textContent = active;
  if (els.disabledCount) els.disabledCount.textContent = disabled;
  if (els.outCount) els.outCount.textContent = out;

  if (els.categoriesList) {
    els.categoriesList.replaceChildren(
      ...Object.entries(state.categories).map(([catId, info]) => {
        const pill = document.createElement('span');
        pill.className = `cat-pill${info.exhausted ? ' is-exhausted' : ''}`;
        pill.innerHTML = `<span>${escapeHtml(info.label)}:</span> <span class="cat-pill__count">${info.remaining} adet (${info.activeStickers || 0}/${info.stickers || 0} aktif)</span>`;
        return pill;
      })
    );
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getFilteredStickers() {
  const query = state.searchQuery.trim().toLowerCase();
  return state.stickers.filter((s) => {
    // Search filter: character, franchise, category label (never file name)
    if (query) {
      const matchName = (s.character || '').toLowerCase().includes(query);
      const matchFranchise = (s.franchise || '').toLowerCase().includes(query);
      const matchCat = (s.category_label || '').toLowerCase().includes(query);
      const matchDesc = (s.visual_description || '').toLowerCase().includes(query);
      if (!matchName && !matchFranchise && !matchCat && !matchDesc) return false;
    }

    // Category filter
    if (state.selectedCategory !== 'all' && s.category !== state.selectedCategory) {
      return false;
    }

    // Status filter
    if (state.selectedStatus === 'active') {
      return s.enabled && s.remaining > 0;
    }
    if (state.selectedStatus === 'disabled') {
      return !s.enabled;
    }
    if (state.selectedStatus === 'out') {
      return s.enabled && s.remaining === 0;
    }

    return true;
  });
}

function createStickerCard(s) {
  const card = document.createElement('article');
  const isOutOfStock = s.enabled && s.remaining === 0;
  card.className = `stock-card${!s.enabled ? ' is-disabled' : ''}${isOutOfStock ? ' is-out' : ''}`;
  card.id = `card-${s.id}`;

  let statusClass = 'stock-card__status-pill--active';
  let statusText = 'Aktif';
  if (!s.enabled) {
    statusClass = 'stock-card__status-pill--disabled';
    statusText = 'Devre Dışı';
  } else if (isOutOfStock) {
    statusClass = 'stock-card__status-pill--out';
    statusText = 'Tükendi';
  }

  card.innerHTML = `
    <div class="stock-card__preview">
      <img class="stock-card__img" src="${escapeHtml(s.asset_path)}" alt="${escapeHtml(s.character)}" loading="lazy" />
      <span class="stock-card__status-pill ${statusClass}" id="pill-${s.id}">${statusText}</span>
    </div>
    <div class="stock-card__details">
      <div class="stock-card__header">
        <div>
          <h3 class="stock-card__character">${escapeHtml(s.character)}</h3>
          <p class="stock-card__franchise">${escapeHtml(s.franchise)}</p>
        </div>
      </div>
      <span class="stock-card__category" data-cat="${escapeHtml(s.category)}">${escapeHtml(s.category_label)}</span>
      <p class="stock-card__desc">${escapeHtml(s.visual_description)}</p>
    </div>
    <div class="stock-card__controls">
      <div class="counter-group" aria-label="Stok adedi">
        <button type="button" class="counter-btn counter-btn--jump" data-action="adjust" data-id="${s.id}" data-delta="-5" title="5 Azalt">-5</button>
        <button type="button" class="counter-btn" data-action="adjust" data-id="${s.id}" data-delta="-1" title="1 Azalt" ${s.remaining === 0 ? 'disabled' : ''}>−</button>
        <input type="number" min="0" max="9999" class="counter-input" data-id="${s.id}" value="${s.remaining}" aria-label="Stok sayısı" />
        <button type="button" class="counter-btn" data-action="adjust" data-id="${s.id}" data-delta="1" title="1 Artır">+</button>
        <button type="button" class="counter-btn counter-btn--jump" data-action="adjust" data-id="${s.id}" data-delta="5" title="5 Artır">+5</button>
      </div>
      <button type="button" class="toggle-btn ${s.enabled ? 'toggle-btn--enabled' : 'toggle-btn--disabled'}" data-action="toggle" data-id="${s.id}">
        ${s.enabled ? '✓ Aktif' : '✕ Kapalı'}
      </button>
    </div>
  `;

  return card;
}

function render() {
  updateStats();
  const list = getFilteredStickers();

  if (els.stickerGrid) {
    if (list.length === 0) {
      els.stickerGrid.innerHTML = '<div class="stocks-empty">Arama kriterlerine uygun çıkartma bulunamadı.</div>';
    } else {
      els.stickerGrid.replaceChildren(...list.map(createStickerCard));
    }
  }
}

/* API Actions with Optimistic UI updates */

async function adjustStock(id, delta) {
  const sticker = state.stickers.find((s) => s.id === id);
  if (!sticker) return;

  const prev = sticker.remaining;
  sticker.remaining = Math.max(0, prev + delta);
  sticker.disabled = !sticker.enabled || sticker.remaining === 0;
  updateCardDOM(sticker);
  updateStats();

  try {
    const res = await fetch(`/api/stocks/${encodeURIComponent(id)}/adjust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ delta }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Hata');
    sticker.remaining = data.remaining;
    sticker.enabled = data.enabled;
    sticker.disabled = data.disabled;
    state.categories = data.categories || state.categories;
    state.totalRemaining = data.total_remaining;
    updateCardDOM(sticker);
    updateStats();
    showToast(`${sticker.character}: Stok ${sticker.remaining} oldu.`);
  } catch (err) {
    console.error('Stok güncellenemedi:', err);
    sticker.remaining = prev;
    updateCardDOM(sticker);
    updateStats();
    showToast('Stok kaydedilemedi!', '⚠️');
  }
}

async function setStock(id, count) {
  const sticker = state.stickers.find((s) => s.id === id);
  if (!sticker) return;

  const prev = sticker.remaining;
  const next = Math.max(0, parseInt(count, 10) || 0);
  sticker.remaining = next;
  sticker.disabled = !sticker.enabled || next === 0;
  updateCardDOM(sticker);
  updateStats();

  try {
    const res = await fetch(`/api/stocks/${encodeURIComponent(id)}/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ count: next }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Hata');
    sticker.remaining = data.remaining;
    sticker.enabled = data.enabled;
    sticker.disabled = data.disabled;
    state.categories = data.categories || state.categories;
    state.totalRemaining = data.total_remaining;
    updateCardDOM(sticker);
    updateStats();
    showToast(`${sticker.character}: Stok ${sticker.remaining} olarak ayarlandı.`);
  } catch (err) {
    console.error('Stok güncellenemedi:', err);
    sticker.remaining = prev;
    updateCardDOM(sticker);
    updateStats();
    showToast('Stok kaydedilemedi!', '⚠️');
  }
}

async function toggleSticker(id) {
  const sticker = state.stickers.find((s) => s.id === id);
  if (!sticker) return;

  const prev = sticker.enabled;
  sticker.enabled = !prev;
  sticker.disabled = !sticker.enabled || sticker.remaining === 0;
  updateCardDOM(sticker);
  updateStats();

  try {
    const res = await fetch(`/api/stocks/${encodeURIComponent(id)}/toggle`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Hata');
    sticker.enabled = data.enabled;
    sticker.disabled = data.disabled;
    sticker.remaining = data.remaining;
    state.categories = data.categories || state.categories;
    state.totalRemaining = data.total_remaining;
    updateCardDOM(sticker);
    updateStats();
    showToast(`${sticker.character}: ${sticker.enabled ? 'Etkinleştirildi' : 'Devre dışı bırakıldı'}.`);
  } catch (err) {
    console.error('Durum değiştirilemedi:', err);
    sticker.enabled = prev;
    updateCardDOM(sticker);
    updateStats();
    showToast('Durum değiştirilemedi!', '⚠️');
  }
}

async function bulkAction(action, extra = {}) {
  try {
    const res = await fetch('/api/stocks/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Hata');
    state.stickers = data.stock || state.stickers;
    state.categories = data.categories || state.categories;
    state.totalRemaining = data.total_remaining;
    render();
    showToast('Toplu işlem başarıyla uygulandı.');
  } catch (err) {
    console.error('Toplu işlem hatası:', err);
    showToast('Toplu işlem başarısız oldu!', '⚠️');
  }
}

function updateCardDOM(sticker) {
  const card = document.getElementById(`card-${sticker.id}`);
  if (!card) return;

  const isOutOfStock = sticker.enabled && sticker.remaining === 0;
  card.classList.toggle('is-disabled', !sticker.enabled);
  card.classList.toggle('is-out', isOutOfStock);

  const pill = document.getElementById(`pill-${sticker.id}`);
  if (pill) {
    pill.className = 'stock-card__status-pill';
    if (!sticker.enabled) {
      pill.classList.add('stock-card__status-pill--disabled');
      pill.textContent = 'Devre Dışı';
    } else if (isOutOfStock) {
      pill.classList.add('stock-card__status-pill--out');
      pill.textContent = 'Tükendi';
    } else {
      pill.classList.add('stock-card__status-pill--active');
      pill.textContent = 'Aktif';
    }
  }

  const input = card.querySelector('.counter-input');
  if (input) input.value = sticker.remaining;

  const decBtn = card.querySelector('.counter-btn[data-delta="-1"]');
  if (decBtn) decBtn.disabled = sticker.remaining === 0;

  const toggleBtn = card.querySelector('.toggle-btn');
  if (toggleBtn) {
    toggleBtn.className = `toggle-btn ${sticker.enabled ? 'toggle-btn--enabled' : 'toggle-btn--disabled'}`;
    toggleBtn.innerHTML = sticker.enabled ? '✓ Aktif' : '✕ Kapalı';
  }
}

/* Event listeners */

function setupEvents() {
  // Search input
  if (els.searchInput) {
    els.searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      render();
    });
  }

  // Category tabs
  if (els.categoryTabs) {
    els.categoryTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      els.categoryTabs.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.selectedCategory = btn.dataset.category || 'all';
      render();
    });
  }

  // Status tabs
  if (els.statusTabs) {
    els.statusTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      els.statusTabs.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.selectedStatus = btn.dataset.status || 'all';
      render();
    });
  }

  // Bulk buttons
  if (els.enableAllBtn) {
    els.enableAllBtn.addEventListener('click', () => bulkAction('enable_all'));
  }
  if (els.disableAllBtn) {
    els.disableAllBtn.addEventListener('click', () => bulkAction('disable_all'));
  }
  if (els.resetAllBtn) {
    els.resetAllBtn.addEventListener('click', () => {
      if (confirm('Tüm çıkartma stokları varsayılan sayıya (20) sıfırlansın ve tümü etkinleştirilsin mi?')) {
        bulkAction('reset', { initialStock: 20 });
      }
    });
  }
  if (els.addFiveAllBtn) {
    els.addFiveAllBtn.addEventListener('click', () => bulkAction('adjust_all', { delta: 5 }));
  }

  // Delegated clicks on sticker cards (+, -, toggle)
  if (els.stickerGrid) {
    els.stickerGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      const action = btn.dataset.action;

      if (action === 'adjust') {
        const delta = parseInt(btn.dataset.delta, 10);
        adjustStock(id, delta);
      } else if (action === 'toggle') {
        toggleSticker(id);
      }
    });

    els.stickerGrid.addEventListener('change', (e) => {
      const input = e.target.closest('.counter-input');
      if (!input) return;
      const id = input.dataset.id;
      setStock(id, input.value);
    });
  }
}

function boot() {
  setupEvents();
  fetchStocks();
}

boot();
