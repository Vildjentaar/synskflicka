'use strict';
const fs = require('fs');
const config = require('./config');
const { validateData, isEligible, assetExists } = require('./validateData');

const defaultDeck = require('../data/tarot_cards.json');
const defaultStickers = require('../data/stickers.json');
const defaultVocab = require('../config/vocabulary.json');

/**
 * Loads deck, stickers and vocabulary, validates them, and exposes lookup helpers.
 * Throws if validation produces errors so the server never starts with bad data.
 */
function loadCatalog(overrides = {}) {
  const opts = {
    deck: overrides.deck || defaultDeck,
    stickers: overrides.stickers || defaultStickers,
    vocab: overrides.vocab || defaultVocab,
    assetRoot: overrides.assetRoot || config.paths.assetRoot,
    strictAssets: overrides.strictAssets ?? config.strictAssets,
  };

  const { errors, warnings } = validateData(opts);
  if (errors.length) {
    const err = new Error(`Data validation failed:\n - ${errors.join('\n - ')}`);
    err.validationErrors = errors;
    throw err;
  }

  const { deck, stickers, vocab, assetRoot, strictAssets } = opts;
  const cardsById = new Map(deck.map((c) => [c.id, c]));
  const enabledCategories = vocab.categories.filter((c) => c.enabled);
  const enabledIds = new Set(enabledCategories.map((c) => c.id));

  const isCompatible = (sticker, categoryId) =>
    sticker.primary_category === categoryId || sticker.secondary_categories.includes(categoryId);

  // A sticker can be offered to the model if it is approved, (in strict mode) has an asset,
  // and fits at least one enabled category.
  const eligibleStickers = stickers.filter(
    (s) => isEligible(s, { assetRoot, strictAssets }) && [...enabledIds].some((id) => isCompatible(s, id))
  );
  const eligibleById = new Map(eligibleStickers.map((s) => [s.id, s]));

  return {
    vocabVersion: vocab.version,
    warnings,
    deck,
    enabledCategories,
    eligibleStickers,
    getCard: (id) => cardsById.get(id),
    getEligibleSticker: (id) => eligibleById.get(id),
    isEnabledCategory: (id) => enabledIds.has(id),
    isCompatible,
    categoryLabel: (id) => (vocab.categories.find((c) => c.id === id) || {}).label || id,
    hasAsset: (s) => assetExists(assetRoot, s.asset_path),
    /** Stickers for a category: primary matches first, else secondary matches (plan 3.4). */
    stickersForCategory(categoryId) {
      const primary = eligibleStickers.filter((s) => s.primary_category === categoryId);
      if (primary.length) return primary;
      return eligibleStickers.filter((s) => s.secondary_categories.includes(categoryId));
    },
  };
}

module.exports = { loadCatalog };
