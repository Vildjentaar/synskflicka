'use strict';

/**
 * Offline provider for development and tests. It produces a plausible, schema-valid response
 * from the prompt's enums so the full pipeline (validation, asset resolution, UI) can run without a key.
 * Pass `respond` to force a specific raw output (e.g. malformed data) in tests.
 */
function createMockProvider({ respond, delayMs = 600 } = {}) {
  return {
    name: 'mock',
    async generate({ user, schema }) {
      await new Promise((r) => setTimeout(r, delayMs));
      if (respond) return typeof respond === 'function' ? respond({ user, schema }) : respond;

      const cards = [...user.matchAll(/^\d\. (.+?) \((upright|reversed)\)/gm)].map((m) => `${m[1]}${m[2] === 'reversed' ? ' (reversed)' : ''}`);
      const categories = schema.properties.category_id.enum;
      const category = categories[Math.floor(Math.random() * categories.length)];
      const catalogJson = user.slice(user.indexOf('['));
      const stickers = JSON.parse(catalogJson).filter((s) => s.primary_category === category);
      const sticker = stickers[Math.floor(Math.random() * stickers.length)];

      return {
        reading_text:
          `${cards[0]} kicks off your day with more confidence than the situation strictly requires. ` +
          `${cards[1]} suggests a small plot twist around lunchtime that you will narrate like a season finale. ` +
          `By the time ${cards[2]} shows up, you may realize the real treasure was the snacks you found along the way. ` +
          `(Mock reading - set GEMINI_API_KEY for the real oracle.)`,
        category_id: category,
        sticker_id: sticker.id,
      };
    },
  };
}

module.exports = { createMockProvider };
