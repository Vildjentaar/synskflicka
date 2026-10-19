'use strict';
const { buildSystemPrompt, buildUserPrompt, buildResponseSchema } = require('./prompt');

const ORIENTATIONS = new Set(['upright', 'reversed']);
const pick = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];

class RequestError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** Lighthearted fallback readings, keyed by category. Used when the LLM fails or misbehaves. */
const FALLBACK_READINGS = {
  chaotic_energy: (c) =>
    `${c[0]}, ${c[1]} and ${c[2]} walked into a bar, and the cards are still trying to piece together what happened next. ` +
    `Your energy today is a shopping cart with one wobbly wheel: fast, loud, and only loosely steerable. ` +
    `Embrace a little spontaneity, but maybe double-check before you hit "reply all".`,
  cynical_observer: (c) =>
    `The cards consulted each other, sighed, and settled on ${c[0]}, ${c[1]} and ${c[2]}. ` +
    `Today you may find yourself watching other people's questionable decisions with the calm of a nature documentary narrator. ` +
    `Your raised eyebrow is fully charged - use it wisely.`,
  hyper_focused: (c) =>
    `${c[0]}, ${c[1]} and ${c[2]} suggest a day with tunnel vision and a to-do list that fears you. ` +
    `You may get a surprising amount done, as long as nobody interrupts you mid-flow. ` +
    `Remember to blink occasionally.`,
  blissful_ignorance: (c) =>
    `With ${c[0]}, ${c[1]} and ${c[2]} on the table, the universe recommends a strictly vibes-based approach to today. ` +
    `Small problems may simply bounce off you like you are wearing invisible bubble wrap. ` +
    `Whatever is going on, you are probably fine - and honestly, you look great doing it.`,
  dramatic_flair: (c) =>
    `${c[0]}, ${c[1]} and ${c[2]} have arrived, and they brought a spotlight. ` +
    `Today the smallest inconvenience may feel like a plot twist worthy of its own theme music. ` +
    `Lean in, take a bow, and let the minor stuff be cinematic.`,
};

function validateDrawRequest(body, catalog) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.cards)) {
    throw new RequestError('Request body must contain a "cards" array.');
  }
  if (body.cards.length !== 3) throw new RequestError('Exactly three cards are required.');

  const seen = new Set();
  return body.cards.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new RequestError(`cards[${i}] must be an object.`);
    const { id, orientation } = entry;
    if (typeof id !== 'string' || id.length > 64) throw new RequestError(`cards[${i}].id must be a string.`);
    if (!ORIENTATIONS.has(orientation)) throw new RequestError(`cards[${i}].orientation must be "upright" or "reversed".`);
    const card = catalog.getCard(id);
    if (!card) throw new RequestError(`cards[${i}].id is not a known card.`);
    if (seen.has(id)) throw new RequestError('The three cards must be distinct.');
    seen.add(id);
    return { card, orientation };
  });
}

function countSentences(text) {
  return (text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text]).length;
}

/**
 * Validates raw model output. Returns { reading, category, sticker, issues } where any of
 * reading/category/sticker may be null if invalid.
 */
function checkModelOutput(raw, catalog, limits) {
  const issues = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { reading: null, category: null, sticker: null, issues: ['output is not a JSON object'] };
  }

  let reading = typeof raw.reading_text === 'string' ? raw.reading_text.trim() : '';
  if (!reading) {
    issues.push('reading_text is empty or missing');
    reading = null;
  } else {
    const n = countSentences(reading);
    if (reading.length < limits.minChars || reading.length > limits.maxChars) {
      issues.push(`reading_text length ${reading.length} outside ${limits.minChars}-${limits.maxChars}`);
      reading = null;
    } else if (n < limits.minSentences || n > limits.maxSentences) {
      issues.push(`reading_text has ${n} sentences, expected ${limits.minSentences}-${limits.maxSentences}`);
      reading = null;
    }
  }

  const category = catalog.isEnabledCategory(raw.category_id) ? raw.category_id : null;
  if (!category) issues.push(`invalid category_id "${raw.category_id}"`);

  let sticker = catalog.getEligibleSticker(raw.sticker_id) || null;
  if (!sticker) issues.push(`unknown or ineligible sticker_id "${raw.sticker_id}"`);
  else if (category && !catalog.isCompatible(sticker, category)) {
    issues.push(`sticker "${sticker.id}" is not compatible with category "${category}"`);
    sticker = null;
  }

  return { reading, category, sticker, issues };
}

function publicSticker(s) {
  return {
    id: s.id,
    asset_path: s.asset_path,
    franchise: s.franchise,
    character: s.character,
    visual_description: s.visual_description,
  };
}

function createReadingService({ catalog, provider, limits, logger = console, rng = Math.random }) {
  function fallbackResult(draw, reason) {
    const category = pick(catalog.enabledCategories, rng).id;
    const sticker = pick(catalog.stickersForCategory(category), rng);
    const names = draw.map((d) => (d.orientation === 'reversed' ? `${d.card.name} (reversed)` : d.card.name));
    logger.warn(JSON.stringify({ event: 'reading_fallback', reason }));
    return { reading: FALLBACK_READINGS[category](names), category, sticker, source: 'fallback' };
  }

  async function generate(body) {
    const draw = validateDrawRequest(body, catalog); // throws RequestError -> 400

    let result;
    try {
      const raw = await provider.generate({
        system: buildSystemPrompt(catalog),
        user: buildUserPrompt(catalog, draw),
        schema: buildResponseSchema(catalog),
      });
      const checked = checkModelOutput(raw, catalog, limits);

      if (!checked.reading || !checked.category) {
        result = fallbackResult(draw, `invalid model output: ${checked.issues.join('; ')}`);
      } else {
        let { sticker } = checked;
        let source = 'llm';
        if (!sticker) {
          // Keep the good reading + category, repair only the sticker (plan 3.4).
          sticker = pick(catalog.stickersForCategory(checked.category), rng);
          source = 'llm_sticker_repaired';
          logger.warn(JSON.stringify({ event: 'sticker_repaired', issues: checked.issues, replacement: sticker.id }));
        }
        result = { reading: checked.reading, category: checked.category, sticker, source };
      }
    } catch (err) {
      const reason = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'llm timeout' : `llm error: ${err.message}`;
      result = fallbackResult(draw, reason);
    }

    return {
      cards: draw.map((d) => ({ id: d.card.id, name: d.card.name, orientation: d.orientation })),
      reading_text: result.reading,
      category_id: result.category,
      category_label: catalog.categoryLabel(result.category),
      sticker: publicSticker(result.sticker),
      source: result.source,
    };
  }

  return { generate };
}

module.exports = { createReadingService, validateDrawRequest, checkModelOutput, RequestError, FALLBACK_READINGS };
