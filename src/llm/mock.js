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
      if (respond !== undefined) return typeof respond === 'function' ? respond({ user, schema }) : respond;

      const cards = [...user.matchAll(/^\d\. (.+?) \((upright|reversed)\)/gm)].map((m) => `${m[1]}${m[2] === 'reversed' ? ' (ters)' : ''}`);
      const categories = schema.properties.category_id.enum;
      const category = categories[Math.floor(Math.random() * categories.length)];
      const catalogJson = user.slice(user.indexOf('['));
      const stickers = JSON.parse(catalogJson).filter((s) => s.primary_category === category);
      const sticker = stickers[Math.floor(Math.random() * stickers.length)];

      return {
        reading_text:
          `${cards[0]}, gününe durumun gerektirdiğinden biraz fazla özgüvenle başlamanı sağlıyor. ` +
          `${cards[1]}, öğle civarında küçük bir olay örgüsü dönüşü olduğunu gösteriyor; sen de bunu sezon finali gibi anlatacaksın. ` +
          `${cards[2]} ortaya çıktığında, asıl hazinenin yol boyunca bulduğun atıştırmalıklar olduğunu fark edebilirsin. ` +
          `(Sahte yorum - gerçek kahin için OPENAI_API_KEY (veya GEMINI_API_KEY) ayarla.)`,
        category_id: category,
        sticker_id: sticker.id,
      };
    },
  };
}

module.exports = { createMockProvider };
