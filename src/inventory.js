'use strict';
const fs = require('fs');
const path = require('path');
const kv = require('./kv');

/**
 * Physical sticker stock and availability manager.
 * Every sticker starts with `initialStock` copies; taking one decrements it.
 * Stickers can also be explicitly disabled (or enabled).
 * A sticker is "in stock" and offered to the tarot reader only when it is enabled AND remaining > 0.
 *
 * If `filePath` is given, stock counts and disabled states are loaded from / saved to that JSON file
 * so settings survive restarts. If the primary file cannot be written (e.g. read-only serverless filesystem),
 * it falls back to /tmp/sticker_stock.json and memory.
 * If Vercel KV is connected, state persists permanently across all Vercel instances.
 */
function createInventory({ stickers, initialStock = 20, filePath = null, categoryLabel = (id) => id, logger = console }) {
  const counts = new Map(stickers.map((s) => [s.id, initialStock]));
  const disabled = new Set();

  const fallbackPath = path.join('/tmp', 'sticker_stock.json');

  function tryLoad(file) {
    if (!file || !fs.existsSync(file)) return false;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.counts && typeof saved.counts === 'object') {
        for (const [id, n] of Object.entries(saved.counts)) {
          if (counts.has(id) && Number.isInteger(n) && n >= 0) counts.set(id, n);
        }
      }
      if (Array.isArray(saved.disabled)) {
        disabled.clear();
        for (const id of saved.disabled) {
          if (counts.has(id)) disabled.add(id);
        }
      }
      return true;
    } catch (err) {
      logger.warn(JSON.stringify({ event: 'stock_load_failed', file, message: err.message }));
      return false;
    }
  }

  // If filePath is provided, try primary filePath first, then fallback to /tmp
  if (filePath) {
    if (!tryLoad(filePath)) {
      tryLoad(fallbackPath);
    }
  }

  // Sync with Vercel KV if configured
  if (kv.isEnabled) {
    kv.get('synskflicka:sticker_stock')
      .then((data) => {
        if (data && data.counts && typeof data.counts === 'object') {
          for (const [id, n] of Object.entries(data.counts)) {
            if (counts.has(id) && Number.isInteger(n) && n >= 0) counts.set(id, n);
          }
          if (Array.isArray(data.disabled)) {
            disabled.clear();
            for (const id of data.disabled) {
              if (counts.has(id)) disabled.add(id);
            }
          }
        } else {
          kv.set('synskflicka:sticker_stock', {
            updated_at: new Date().toISOString(),
            counts: Object.fromEntries(counts),
            disabled: [...disabled],
          }).catch(() => {});
        }
      })
      .catch((err) => {
        logger.warn(JSON.stringify({ event: 'kv_stock_load_failed', message: err.message }));
      });
  }

  function persist() {
    if (kv.isEnabled) {
      kv.set('synskflicka:sticker_stock', {
        updated_at: new Date().toISOString(),
        counts: Object.fromEntries(counts),
        disabled: [...disabled],
      }).catch((err) => {
        logger.warn(JSON.stringify({ event: 'kv_stock_persist_failed', message: err.message }));
      });
    }

    if (!filePath) return;
    const payload = JSON.stringify(
      {
        updated_at: new Date().toISOString(),
        counts: Object.fromEntries(counts),
        disabled: [...disabled],
      },
      null,
      2
    );

    function tryWrite(dest) {
      if (!dest) return false;
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = `${dest}.tmp`;
        fs.writeFileSync(tmp, payload, 'utf8');
        fs.renameSync(tmp, dest);
        return true;
      } catch (err) {
        return false;
      }
    }

    if (!tryWrite(filePath)) {
      if (!tryWrite(fallbackPath)) {
        logger.warn(JSON.stringify({ event: 'stock_persist_failed', file: filePath }));
      }
    }
  }

  const remaining = (id) => counts.get(id) ?? 0;
  const isEnabled = (id) => !disabled.has(id);
  const isInStock = (id) => isEnabled(id) && remaining(id) > 0;

  return {
    initialStock,
    remaining,
    isEnabled,
    isInStock,

    /** Takes one copy. Returns { ok, remaining } or { ok: false, reason: 'unknown' | 'out_of_stock' | 'disabled' }. */
    take(id) {
      if (!counts.has(id)) return { ok: false, reason: 'unknown' };
      if (!isEnabled(id)) return { ok: false, reason: 'disabled', remaining: remaining(id) };
      const n = counts.get(id);
      if (n <= 0) return { ok: false, reason: 'out_of_stock', remaining: 0 };
      counts.set(id, n - 1);
      persist();
      return { ok: true, remaining: n - 1 };
    },

    /** Explicitly set remaining stock for a sticker. */
    setStock(id, count) {
      if (!counts.has(id)) return { ok: false, reason: 'unknown' };
      const n = Math.max(0, parseInt(count, 10) || 0);
      counts.set(id, n);
      persist();
      return { ok: true, id, remaining: n, enabled: isEnabled(id), disabled: !isEnabled(id) || n === 0 };
    },

    /** Increase or decrease stock by delta. */
    adjustStock(id, delta) {
      if (!counts.has(id)) return { ok: false, reason: 'unknown' };
      const current = counts.get(id);
      const next = Math.max(0, current + (parseInt(delta, 10) || 0));
      counts.set(id, next);
      persist();
      return { ok: true, id, remaining: next, enabled: isEnabled(id), disabled: !isEnabled(id) || next === 0 };
    },

    /** Set enabled/disabled state for a sticker. */
    setEnabled(id, enabled) {
      if (!counts.has(id)) return { ok: false, reason: 'unknown' };
      if (enabled) {
        disabled.delete(id);
      } else {
        disabled.add(id);
      }
      persist();
      return { ok: true, id, remaining: remaining(id), enabled: isEnabled(id), disabled: !isEnabled(id) || remaining(id) === 0 };
    },

    /** Toggle enabled/disabled state for a sticker. */
    toggleEnabled(id) {
      if (!counts.has(id)) return { ok: false, reason: 'unknown' };
      return this.setEnabled(id, !isEnabled(id));
    },

    /** Bulk enable or disable all stickers. */
    setAllEnabled(enabled) {
      disabled.clear();
      if (!enabled) {
        for (const s of stickers) disabled.add(s.id);
      }
      persist();
      return { ok: true };
    },

    /** Reset all counts to initialStock and enable everything. */
    resetStock(customInitial = initialStock) {
      const n = Math.max(0, parseInt(customInitial, 10) || initialStock);
      for (const s of stickers) {
        counts.set(s.id, n);
      }
      disabled.clear();
      persist();
      return { ok: true };
    },

    /** Adjust all sticker stocks by a delta. */
    adjustAllStock(delta) {
      const d = parseInt(delta, 10) || 0;
      for (const s of stickers) {
        counts.set(s.id, Math.max(0, counts.get(s.id) + d));
      }
      persist();
      return { ok: true };
    },

    /** Every sticker with display info, enabled status, and remaining count. */
    snapshot() {
      return stickers.map((s) => {
        const count = remaining(s.id);
        const enabled = isEnabled(s.id);
        return {
          id: s.id,
          character: s.character || 'Bilinmeyen Karakter',
          franchise: s.franchise || 'Özgün',
          category: s.primary_category,
          category_label: categoryLabel(s.primary_category),
          asset_path: s.asset_path,
          visual_description: s.visual_description,
          remaining: count,
          enabled,
          disabled: !enabled || count === 0,
        };
      });
    },

    /** Remaining totals per (primary) category taking stock and enabled state into account. */
    categoryTotals() {
      const totals = {};
      for (const s of stickers) {
        const t = (totals[s.primary_category] ||= {
          label: categoryLabel(s.primary_category),
          remaining: 0,
          stickers: 0,
          activeStickers: 0,
        });
        const inStock = isInStock(s.id);
        t.remaining += remaining(s.id);
        t.stickers += 1;
        if (inStock) t.activeStickers += 1;
      }
      for (const t of Object.values(totals)) t.exhausted = t.activeStickers === 0;
      return totals;
    },

    total: () => [...counts.values()].reduce((a, b) => a + b, 0),
  };
}

module.exports = { createInventory };
