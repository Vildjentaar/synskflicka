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

  const base = {
    vocabVersion: vocab.version,
    warnings,
    deck,
    getCard: (id) => cardsById.get(id),
    isCompatible,
    categoryLabel: (id) => (vocab.categories.find((c) => c.id === id) || {}).label || id,
    hasAsset: (s) => assetExists(assetRoot, s.asset_path),
    /** Enabled categories whose stickers have all run out (only non-empty on stock-aware views). */
    exhaustedCategories: [],
  };

  const catalog = {
    ...base,
    ...makeView(enabledCategories, eligibleStickers, isCompatible),
    /**
     * Returns a copy of the catalog limited to stickers that are still in stock.
     * A category is exhausted when every sticker with that primary_category has run out; it is then
     * removed from the enabled categories so the model picks the next best fitting one.
     */
    withStock(isInStock) {
      const inStock = eligibleStickers.filter((s) => isInStock(s.id));
      const exhausted = enabledCategories.filter((c) => !inStock.some((s) => s.primary_category === c.id));
      const available = enabledCategories.filter((c) => !exhausted.includes(c));
      const stickersLeft = inStock.filter((s) => available.some((c) => isCompatible(s, c.id)));
      return {
        ...catalog,
        ...makeView(available, stickersLeft, isCompatible),
        exhaustedCategories: exhausted,
      };
    },
  };
  return catalog;
}

/** Lookup helpers over a given set of enabled categories and eligible stickers. */
function makeView(enabledCategories, eligibleStickers, isCompatible) {
  const enabledIds = new Set(enabledCategories.map((c) => c.id));
  const eligibleById = new Map(eligibleStickers.map((s) => [s.id, s]));
  return {
    enabledCategories,
    eligibleStickers,
    getEligibleSticker: (id) => eligibleById.get(id),
    isEnabledCategory: (id) => enabledIds.has(id),
    isCompatible,
    /** Stickers for a category: primary matches first, else secondary matches (plan 3.4). */
    stickersForCategory(categoryId) {
      const primary = eligibleStickers.filter((s) => s.primary_category === categoryId);
      if (primary.length) return primary;
      return eligibleStickers.filter((s) => s.secondary_categories.includes(categoryId));
    },
  };
}

module.exports = { loadCatalog };
