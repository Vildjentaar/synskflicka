'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../src/config');
const { validateData } = require('../src/validateData');
const { loadCatalog } = require('../src/catalog');

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const deck = read(config.paths.deck);
const stickers = read(config.paths.stickers);
const vocab = read(config.paths.vocabulary);
const base = { deck, stickers, vocab, assetRoot: config.paths.assetRoot, strictAssets: false };
const clone = (x) => JSON.parse(JSON.stringify(x));

test('shipped data has no blocking errors', () => {
  const { errors } = validateData(base);
  assert.deepEqual(errors, []);
});

test('detects label mismatch between id and character for manual review', () => {
  const s = clone(stickers);
  s[0].id = 'rachel_test';
  s[0].character = 'Monica Geller';
  const { warnings } = validateData({ ...base, stickers: s });
  assert.ok(warnings.some((w) => w.includes('MANUAL REVIEW') && w.includes('rachel_test')));
});

test('detects duplicate sticker ids', () => {
  const s = clone(stickers);
  s[1].id = s[0].id;
  assert.ok(validateData({ ...base, stickers: s }).errors.some((e) => e.includes('duplicate id')));
});

test('detects unknown categories and tags', () => {
  const s = clone(stickers);
  s[0].primary_category = 'mystery';
  s[1].vibe_tags.push('made_up_vibe');
  const { errors } = validateData({ ...base, stickers: s });
  assert.ok(errors.some((e) => e.includes('"mystery"')));
  assert.ok(errors.some((e) => e.includes('made_up_vibe')));
});

test('detects missing required fields', () => {
  const s = clone(stickers);
  delete s[0].visual_description;
  delete s[0].franchise;
  const { errors } = validateData({ ...base, stickers: s });
  assert.ok(errors.some((e) => e.includes('visual_description')));
  assert.ok(errors.some((e) => e.includes('franchise')));
});

test('rejects asset paths outside /stickers', () => {
  const s = clone(stickers);
  s[0].asset_path = '/stickers/../package.json';
  assert.ok(validateData({ ...base, stickers: s }).errors.some((e) => e.includes('must live under /stickers/')));
});

test('enabled category without a primary sticker is an error', () => {
  const v = clone(vocab);
  v.categories.find((c) => c.id === 'hyper_focused').enabled = true;
  assert.ok(validateData({ ...base, vocab: v }).errors.some((e) => e.includes('hyper_focused')));
});

test('unapproved stickers are excluded and can break coverage', () => {
  const s = clone(stickers).map((x) => ({ ...x, annotation_status: 'needs_review' }));
  assert.ok(validateData({ ...base, stickers: s }).errors.some((e) => e.includes('no usable approved sticker')));
});

test('strict mode: missing assets become errors; present assets pass', () => {
  const missingSticker = { ...stickers[0], id: 'missing_test', asset_path: '/stickers/nonexistent.png' };
  assert.ok(validateData({ ...base, stickers: [...stickers, missingSticker], strictAssets: true }).errors.some((e) => e.includes('asset file not found')));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-'));
  fs.mkdirSync(path.join(tmp, 'stickers'));
  for (const s of stickers) fs.writeFileSync(path.join(tmp, s.asset_path), '');
  assert.deepEqual(validateData({ ...base, assetRoot: tmp, strictAssets: true }).errors, []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('every eligible sticker id resolves to exactly one record', () => {
  const catalog = loadCatalog({ strictAssets: false });
  for (const s of catalog.eligibleStickers) {
    assert.equal(stickers.filter((x) => x.id === s.id).length, 1);
    assert.equal(catalog.getEligibleSticker(s.id), s);
  }
  for (const c of catalog.enabledCategories) assert.ok(catalog.stickersForCategory(c.id).length > 0, c.id);
});
