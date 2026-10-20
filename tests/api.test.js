'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { loadCatalog } = require('../src/catalog');
const { createMockProvider } = require('../src/llm/mock');

const silent = { info() {}, warn() {}, error() {} };
const catalog = loadCatalog({ strictAssets: false });
const goodSticker = catalog.stickersForCategory('cynical_observer')[0];
const incompatible = catalog.eligibleStickers.find((s) => !catalog.isCompatible(s, 'chaotic_energy'));
const READING = 'The Fool says you will start strong. The Tower adds a surprise at lunch. The Star promises a calm evening with snacks.';

const DRAW = {
  cards: [
    { id: 'the_fool', orientation: 'upright' },
    { id: 'the_tower', orientation: 'reversed' },
    { id: 'three_of_cups', orientation: 'upright' },
  ],
};

/** Spin up an app with a scripted provider and return a fetch helper. */
async function withApp(provider, fn) {
  const app = createApp({ catalog, provider, logger: silent });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(async (body, raw) => {
      const res = await fetch(`${base}/api/generate-reading`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw ?? JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    }, base);
  } finally {
    server.close();
  }
}

const respond = (r) => createMockProvider({ respond: r, delayMs: 0 });

describe('request validation', () => {
  const cases = [
    ['missing cards', {}],
    ['two cards', { cards: DRAW.cards.slice(0, 2) }],
    ['four cards', { cards: [...DRAW.cards, { id: 'the_sun', orientation: 'upright' }] }],
    ['duplicate cards', { cards: [DRAW.cards[0], DRAW.cards[0], DRAW.cards[1]] }],
    ['invalid orientation', { cards: [{ id: 'the_fool', orientation: 'sideways' }, DRAW.cards[1], DRAW.cards[2]] }],
    ['unknown id', { cards: [{ id: 'the_intern', orientation: 'upright' }, DRAW.cards[1], DRAW.cards[2]] }],
    ['non-string id', { cards: [{ id: 42, orientation: 'upright' }, DRAW.cards[1], DRAW.cards[2]] }],
  ];
  for (const [name, body] of cases) {
    test(name, () =>
      withApp(respond({}), async (post) => {
        const { status, json } = await post(body);
        assert.equal(status, 400);
        assert.ok(json.error);
      }));
  }

  test('malformed JSON', () =>
    withApp(respond({}), async (post) => {
      const { status } = await post(null, '{"cards": [');
      assert.equal(status, 400);
    }));

  test('oversized body', () =>
    withApp(respond({}), async (post) => {
      const { status } = await post({ cards: DRAW.cards, padding: 'x'.repeat(5000) });
      assert.equal(status, 413);
    }));
});

describe('model output handling', () => {
  test('valid output passes through with canonical sticker data', () =>
    withApp(respond({ reading_text: READING, category_id: 'cynical_observer', sticker_id: goodSticker.id }), async (post) => {
      const { status, json } = await post(DRAW);
      assert.equal(status, 200);
      assert.equal(json.source, 'llm');
      assert.equal(json.reading_text, READING);
      assert.equal(json.category_id, 'cynical_observer');
      assert.deepEqual(json.sticker, {
        id: goodSticker.id,
        asset_path: goodSticker.asset_path,
        franchise: goodSticker.franchise,
        character: goodSticker.character,
        visual_description: goodSticker.visual_description,
      });
      assert.deepEqual(json.cards.map((c) => c.name), ['Deli', 'Kule', 'Kupa Üçlüsü']);
      assert.equal(json.cards[1].orientation, 'reversed');
    }));

  test('invalid sticker id is repaired, reading kept', () =>
    withApp(respond({ reading_text: READING, category_id: 'dramatic_flair', sticker_id: 'made_up_sticker' }), async (post) => {
      const { json } = await post(DRAW);
      assert.equal(json.source, 'llm_sticker_repaired');
      assert.equal(json.reading_text, READING);
      assert.equal(catalog.getEligibleSticker(json.sticker.id).primary_category, 'dramatic_flair');
    }));

  test('incompatible category/sticker is repaired', () =>
    withApp(respond({ reading_text: READING, category_id: 'chaotic_energy', sticker_id: incompatible.id }), async (post) => {
      const { json } = await post(DRAW);
      assert.equal(json.source, 'llm_sticker_repaired');
      assert.ok(catalog.isCompatible(catalog.getEligibleSticker(json.sticker.id), 'chaotic_energy'));
    }));

  const fallbackCases = [
    ['non-object output', 'just a string'],
    ['invented category', { reading_text: READING, category_id: 'mystery', sticker_id: goodSticker.id }],
    ['disabled category', { reading_text: READING, category_id: 'hyper_focused', sticker_id: goodSticker.id }],
    ['empty reading', { reading_text: '   ', category_id: 'cynical_observer', sticker_id: goodSticker.id }],
    ['too-long reading', { reading_text: 'Blah blah. '.repeat(120), category_id: 'cynical_observer', sticker_id: goodSticker.id }],
  ];
  for (const [name, raw] of fallbackCases) {
    test(`${name} -> full fallback`, () =>
      withApp(respond(raw), async (post) => {
        const { status, json } = await post(DRAW);
        assert.equal(status, 200);
        assert.equal(json.source, 'fallback');
        assert.ok(catalog.isEnabledCategory(json.category_id));
        assert.ok(catalog.isCompatible(catalog.getEligibleSticker(json.sticker.id), json.category_id));
        assert.ok(json.reading_text.includes('Deli'));
      }));
  }

  test('provider error -> fallback', () =>
    withApp({ name: 'boom', generate: async () => { throw new Error('HTTP 500'); } }, async (post) => {
      const { json } = await post(DRAW);
      assert.equal(json.source, 'fallback');
    }));

  test('provider timeout -> fallback', () =>
    withApp(
      { name: 'slow', generate: () => fetch('http://10.255.255.1', { signal: AbortSignal.timeout(50) }) },
      async (post) => {
        const { json } = await post(DRAW);
        assert.equal(json.source, 'fallback');
      }
    ));
});

describe('misc endpoints', () => {
  test('deck endpoint exposes no meanings', () =>
    withApp(respond({}), async (_post, base) => {
      const json = await (await fetch(`${base}/api/deck`)).json();
      assert.equal(json.cards.length, 78);
      assert.equal(json.cards[0].upright_meaning, undefined);
    }));

  test('missing sticker asset returns 404, not a crash', () =>
    withApp(respond({}), async (_post, base) => {
      const res = await fetch(`${base}/stickers/does_not_exist.png`);
      assert.equal(res.status, 404);
    }));
});

describe('sticker stock', () => {
  const { createInventory } = require('../src/inventory');
  const { buildSystemPrompt } = require('../src/prompt');

  async function withStockApp(provider, inventory, fn) {
    const app = createApp({ catalog, provider, inventory, logger: silent });
    const server = await new Promise((r) => {
      const s = app.listen(0, () => r(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base);
    } finally {
      server.close();
    }
  }
  const newInventory = (initialStock = 20) => createInventory({ stickers: catalog.eligibleStickers, initialStock, categoryLabel: catalog.categoryLabel });
  const take = (base, id) => fetch(`${base}/api/stickers/${id}/take`, { method: 'POST' }).then(async (r) => ({ status: r.status, json: await r.json() }));

  test('take decrements and reports full inventory incl. categories', () => {
    const inv = newInventory();
    return withStockApp(respond({}), inv, async (base) => {
      const { status, json } = await take(base, goodSticker.id);
      assert.equal(status, 200);
      assert.equal(json.remaining, 19);
      assert.equal(json.stock.length, catalog.eligibleStickers.length);
      assert.ok(json.stock.every((s) => typeof s.category === 'string' && typeof s.remaining === 'number'));
      assert.equal(json.total_remaining, catalog.eligibleStickers.length * 20 - 1);
    });
  });

  test('sticker at 0 is disabled (409) and no longer offered', () => {
    const inv = newInventory(1);
    return withStockApp(respond({}), inv, async (base) => {
      assert.equal((await take(base, goodSticker.id)).status, 200);
      const again = await take(base, goodSticker.id);
      assert.equal(again.status, 409);
      assert.equal(again.json.stock.find((s) => s.id === goodSticker.id).disabled, true);
      assert.equal(catalog.withStock(inv.isInStock).getEligibleSticker(goodSticker.id), undefined);
    });
  });

  test('unknown sticker -> 404', () =>
    withStockApp(respond({}), newInventory(), async (base) => {
      assert.equal((await take(base, 'nope')).status, 404);
    }));

  test('exhausted category is removed and announced in the system prompt', () => {
    const inv = newInventory(1);
    catalog.stickersForCategory('chaotic_energy').forEach((s) => inv.take(s.id));
    const view = catalog.withStock(inv.isInStock);
    assert.equal(view.isEnabledCategory('chaotic_energy'), false);
    assert.deepEqual(view.exhaustedCategories.map((c) => c.id), ['chaotic_energy']);
    assert.match(buildSystemPrompt(view), /SOLD OUT[^\n]*chaotic_energy/);
    assert.ok(view.eligibleStickers.every((s) => s.primary_category !== 'chaotic_energy'));
  });

  test('reading for a sold-out category falls back to an available one', () => {
    const inv = newInventory(1);
    catalog.stickersForCategory('chaotic_energy').forEach((s) => inv.take(s.id));
    return withStockApp(respond({ reading_text: READING, category_id: 'chaotic_energy', sticker_id: goodSticker.id }), inv, async (base) => {
      const res = await fetch(`${base}/api/generate-reading`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(DRAW) });
      const json = await res.json();
      assert.notEqual(json.category_id, 'chaotic_energy');
      assert.deepEqual(json.exhausted_categories, ['chaotic_energy']);
      assert.equal(json.sticker_remaining, 1);
    });
  });

  test('everything sold out -> 503', () => {
    const inv = newInventory(1);
    catalog.eligibleStickers.forEach((s) => inv.take(s.id));
    return withStockApp(respond({}), inv, async (base) => {
      const res = await fetch(`${base}/api/generate-reading`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(DRAW) });
      assert.equal(res.status, 503);
    });
  });

  test('GET /api/stocks returns full inventory without file names in display fields', () => {
    const inv = newInventory();
    return withStockApp(respond({}), inv, async (base) => {
      const res = await fetch(`${base}/api/stocks`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.stock.length, catalog.eligibleStickers.length);
      const first = json.stock[0];
      assert.ok(first.character);
      assert.ok(first.franchise);
      assert.ok(first.category_label);
      assert.equal(typeof first.remaining, 'number');
      assert.equal(first.enabled, true);
    });
  });

  test('POST /api/stocks/:id/adjust increases and decreases stock', () => {
    const inv = newInventory(10);
    return withStockApp(respond({}), inv, async (base) => {
      const resInc = await fetch(`${base}/api/stocks/${goodSticker.id}/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta: 5 }),
      });
      const dataInc = await resInc.json();
      assert.equal(dataInc.remaining, 15);

      const resDec = await fetch(`${base}/api/stocks/${goodSticker.id}/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta: -20 }),
      });
      const dataDec = await resDec.json();
      assert.equal(dataDec.remaining, 0);
      assert.equal(dataDec.disabled, true);
    });
  });

  test('POST /api/stocks/:id/toggle enables and disables stickers from system pool', () => {
    const inv = newInventory(10);
    return withStockApp(respond({}), inv, async (base) => {
      // Initially in stock
      assert.ok(inv.isInStock(goodSticker.id));

      // Disable it
      const resToggle = await fetch(`${base}/api/stocks/${goodSticker.id}/toggle`, { method: 'POST' });
      const dataToggle = await resToggle.json();
      assert.equal(dataToggle.enabled, false);
      assert.equal(inv.isInStock(goodSticker.id), false);
      assert.equal(catalog.withStock(inv.isInStock).getEligibleSticker(goodSticker.id), undefined);

      // Re-enable it
      const resEnable = await fetch(`${base}/api/stocks/${goodSticker.id}/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      const dataEnable = await resEnable.json();
      assert.equal(dataEnable.enabled, true);
      assert.equal(inv.isInStock(goodSticker.id), true);
      assert.ok(catalog.withStock(inv.isInStock).getEligibleSticker(goodSticker.id));
    });
  });

  test('POST /api/stocks/bulk performs bulk enable, disable, and reset', () => {
    const inv = newInventory(10);
    return withStockApp(respond({}), inv, async (base) => {
      // Disable all
      await fetch(`${base}/api/stocks/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disable_all' }),
      });
      assert.ok(catalog.eligibleStickers.every((s) => !inv.isInStock(s.id)));

      // Enable all
      await fetch(`${base}/api/stocks/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'enable_all' }),
      });
      assert.ok(catalog.eligibleStickers.every((s) => inv.isInStock(s.id)));

      // Reset
      await fetch(`${base}/api/stocks/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset', initialStock: 25 }),
      });
      assert.equal(inv.remaining(goodSticker.id), 25);
    });
  });

  test('GET /stocks serves stocks HTML page', () => {
    return withStockApp(respond({}), newInventory(), async (base) => {
      const res = await fetch(`${base}/stocks`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('Stok Odası'));
    });
  });
});
