'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Physical sticker stock. Every sticker starts with `initialStock` copies; taking one decrements it.
 * A sticker with 0 left is "disabled" (never offered to the model again).
 *
 * If `filePath` is given, counts are loaded from / saved to that JSON file so stock survives restarts.
 * Delete the file to reset everything back to `initialStock`. If the file can't be written
 * (e.g. read-only serverless filesystem) stock keeps working in memory and a warning is logged.
 */
function createInventory({ stickers, initialStock = 20, filePath = null, categoryLabel = (id) => id, logger = console }) {
  const counts = new Map(stickers.map((s) => [s.id, initialStock]));

  if (filePath && fs.existsSync(filePath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const [id, n] of Object.entries(saved.counts || {})) {
        if (counts.has(id) && Number.isInteger(n) && n >= 0) counts.set(id, Math.min(n, initialStock));
      }
    } catch (err) {
      logger.warn(JSON.stringify({ event: 'stock_load_failed', file: filePath, message: err.message }));
    }
  }

  function persist() {
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ updated_at: new Date().toISOString(), counts: Object.fromEntries(counts) }, null, 2));
      fs.renameSync(tmp, filePath);
    } catch (err) {
      logger.warn(JSON.stringify({ event: 'stock_persist_failed', file: filePath, message: err.message }));
    }
  }

  const remaining = (id) => counts.get(id) ?? 0;

  return {
    initialStock,
    remaining,
    isInStock: (id) => remaining(id) > 0,

    /** Takes one copy. Returns { ok, remaining } or { ok: false, reason: 'unknown' | 'out_of_stock' }. */
    take(id) {
      if (!counts.has(id)) return { ok: false, reason: 'unknown' };
      const n = counts.get(id);
      if (n <= 0) return { ok: false, reason: 'out_of_stock', remaining: 0 };
      counts.set(id, n - 1);
      persist();
      return { ok: true, remaining: n - 1 };
    },

    /** Every sticker (including disabled ones) with its category and remaining count. */
    snapshot() {
      return stickers.map((s) => ({
        id: s.id,
        character: s.character,
        franchise: s.franchise,
        category: s.primary_category,
        category_label: categoryLabel(s.primary_category),
        remaining: remaining(s.id),
        disabled: remaining(s.id) === 0,
      }));
    },

    /** Remaining totals per (primary) category. */
    categoryTotals() {
      const totals = {};
      for (const s of stickers) {
        const t = (totals[s.primary_category] ||= { label: categoryLabel(s.primary_category), remaining: 0, stickers: 0 });
        t.remaining += remaining(s.id);
        t.stickers += 1;
      }
      for (const t of Object.values(totals)) t.exhausted = t.remaining === 0;
      return totals;
    },

    total: () => [...counts.values()].reduce((a, b) => a + b, 0),
  };
}

module.exports = { createInventory };
