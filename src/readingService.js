'use strict';
const { buildSystemPrompt, buildUserPrompt, buildResponseSchema } = require('./prompt');

const ORIENTATIONS = new Set(['upright', 'reversed']);
const pick = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Lighthearted fallback readings, keyed by category. Used when the LLM fails or misbehaves. */
const FALLBACK_READINGS = {
  chaotic_energy: (c) =>
    `${c[0]}, ${c[1]} ve ${c[2]} bir bara girmiş; kartlar sonrasında ne olduğunu hâlâ kafalarında birleştirmeye çalışıyor. ` +
    `Bugünkü enerjin tekerlerinden biri sallanan bir alışveriş arabası gibi: hızlı, gürültülü ve ancak yarı yarıya yönetilebilir. ` +
    `Biraz doğallığa yer aç, ama "herkese yanıtla" tuşuna basmadan önce bir kez daha kontrol et.`,
  cynical_observer: (c) =>
    `Kartlar birbirine danıştı, iç çekti ve ${c[0]}, ${c[1]} ve ${c[2]} üzerinde karar kıldı. ` +
    `Bugün başkalarının kuşkulu kararlarını, bir belgesel anlatıcısının sakinliğiyle izlerken bulabilirsin. ` +
    `Kalkık kaşın tamamen şarjlı - akıllıca kullan.`,
  hyper_focused: (c) =>
    `${c[0]}, ${c[1]} ve ${c[2]}, tünel görüşü ve senden korkan bir yapılacaklar listesi olan bir günü işaret ediyor. ` +
    `Kimse seni akışının ortasında bölmediği sürece şaşırtıcı miktarda iş bitirebilirsin. ` +
    `Ara sıra göz kırpmayı unutma.`,
  blissful_ignorance: (c) =>
    `Masada ${c[0]}, ${c[1]} ve ${c[2]} varken evren bugün için tamamen havana göre takılmanı öneriyor. ` +
    `Küçük sorunlar, görünmez bir balonlu naylon giymişsin gibi üzerinden kayıp gidebilir. ` +
    `Ne olursa olsun, büyük ihtimalle iyisin - ve açıkçası bunu yaparken harika görünüyorsun.`,
  dramatic_flair: (c) =>
    `${c[0]}, ${c[1]} ve ${c[2]} geldi ve yanında bir spot ışığı da getirdi. ` +
    `Bugün en küçük aksilik bile kendi tema müziğini hak eden bir olay örgüsü dönüşü gibi hissettirebilir. ` +
    `Rolüne gir, reverans yap ve ufak tefek şeyleri sinematik olmaya bırak.`,
};

function validateDrawRequest(body, catalog) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.cards)) {
    throw new RequestError('İstek gövdesi bir "cards" dizisi içermelidir.');
  }
  if (body.cards.length !== 3) throw new RequestError('Tam olarak üç kart gereklidir.');

  const seen = new Set();
  return body.cards.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new RequestError(`cards[${i}] bir nesne olmalıdır.`);
    const { id, orientation } = entry;
    if (typeof id !== 'string' || id.length > 64) throw new RequestError(`cards[${i}].id bir metin olmalıdır.`);
    if (!ORIENTATIONS.has(orientation)) throw new RequestError(`cards[${i}].orientation "upright" veya "reversed" olmalıdır.`);
    const card = catalog.getCard(id);
    if (!card) throw new RequestError(`cards[${i}].id bilinen bir kart değil.`);
    if (seen.has(id)) throw new RequestError('Üç kart birbirinden farklı olmalıdır.');
    seen.add(id);
    return { card, orientation };
  });
}

function countSentences(text) {
  return (text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text]).length;
}

function countWords(text) {
  return (text.trim().match(/\S+/g) || []).length;
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
    const sentences = countSentences(reading);
    const words = countWords(reading);
    if (limits.minWords && words < limits.minWords) {
      issues.push(`reading_text has ${words} words, expected at least ${limits.minWords}`);
      reading = null;
    } else if (limits.maxWords && words > limits.maxWords) {
      issues.push(`reading_text has ${words} words, expected at most ${limits.maxWords}`);
      reading = null;
    } else if (limits.minChars && reading.length < limits.minChars) {
      issues.push(`reading_text length ${reading.length} below ${limits.minChars}`);
      reading = null;
    } else if (limits.maxChars && reading.length > limits.maxChars) {
      issues.push(`reading_text length ${reading.length} exceeds ${limits.maxChars}`);
      reading = null;
    } else if (limits.minSentences && sentences < limits.minSentences) {
      issues.push(`reading_text has ${sentences} sentences, expected at least ${limits.minSentences}`);
      reading = null;
    } else if (limits.maxSentences && sentences > limits.maxSentences) {
      issues.push(`reading_text has ${sentences} sentences, expected at most ${limits.maxSentences}`);
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

/**
 * Determines a category and sticker for fallback by weighting categories
 * proportionally to the number of sticker types they have available (from most to least).
 */
function pickWeightedCategory(catalog, rng = Math.random) {
  const candidates = catalog.enabledCategories
    .map((c) => {
      const stickers = catalog.stickersForCategory(c.id);
      return { id: c.id, stickers, weight: stickers.length };
    })
    .filter((c) => c.weight > 0);

  if (!candidates.length) {
    const fallbackCat = pick(catalog.enabledCategories, rng).id;
    return { category: fallbackCat, sticker: pick(catalog.stickersForCategory(fallbackCat), rng) };
  }

  const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
  let roll = rng() * totalWeight;
  for (const candidate of candidates) {
    if (roll < candidate.weight) {
      return { category: candidate.id, sticker: pick(candidate.stickers, rng) };
    }
    roll -= candidate.weight;
  }
  const last = candidates[candidates.length - 1];
  return { category: last.id, sticker: pick(last.stickers, rng) };
}

function createReadingService({ catalog: baseCatalog, provider, limits, inventory = null, logger = console, rng = Math.random }) {
  function fallbackResult(catalog, draw, reason, fallbackType = 'full_fallback') {
    const { category, sticker } = pickWeightedCategory(catalog, rng);
    const names = draw.map((d) => (d.orientation === 'reversed' ? `${d.card.name} (ters)` : d.card.name));
    logger.warn(JSON.stringify({ event: 'reading_fallback', fallback_type: fallbackType, reason }));
    return { reading: FALLBACK_READINGS[category](names), category, sticker, source: 'fallback', fallback_type: fallbackType, fallback_reason: reason };
  }

  async function generate(body) {
    const draw = validateDrawRequest(body, baseCatalog); // throws RequestError -> 400

    // Only offer stickers that are still in stock; sold-out categories drop out of the prompt.
    const catalog = inventory ? baseCatalog.withStock(inventory.isInStock) : baseCatalog;
    if (!catalog.enabledCategories.length || !catalog.eligibleStickers.length) {
      throw new RequestError('Tüm çıkartmalar tükendi! Ruhlar yeni stok bekliyor.', 503);
    }

    let result;
    try {
      const raw = await provider.generate({
        system: buildSystemPrompt(catalog),
        user: buildUserPrompt(catalog, draw),
        schema: buildResponseSchema(catalog),
      });
      const checked = checkModelOutput(raw, catalog, limits);

      if (!checked.reading || !checked.category) {
        if (typeof provider.reportFailure === 'function') {
          provider.reportFailure(`invalid model output: ${checked.issues.join('; ')}`);
        }
        result = fallbackResult(catalog, draw, `invalid model output: ${checked.issues.join('; ')}`, 'invalid_model_output');
      } else {
        let { sticker } = checked;
        let source = 'llm';
        if (!sticker) {
          // Keep the good reading + category, repair only the sticker (plan 3.4).
          sticker = pick(catalog.stickersForCategory(checked.category), rng);
          source = 'llm_sticker_repaired';
          logger.warn(JSON.stringify({ event: 'sticker_repaired', issues: checked.issues, replacement: sticker.id, fallback_type: 'sticker_repaired' }));
        }
        result = { reading: checked.reading, category: checked.category, sticker, source, fallback_type: source === 'llm_sticker_repaired' ? 'sticker_repaired' : null };
      }
    } catch (err) {
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      const fallbackType = isTimeout ? 'timeout' : 'provider_error';
      const reason = isTimeout ? 'llm timeout' : `llm error: ${err.message}`;
      result = fallbackResult(catalog, draw, reason, fallbackType);
    }

    return {
      cards: draw.map((d) => ({ id: d.card.id, name: d.card.name, orientation: d.orientation })),
      reading_text: result.reading,
      category_id: result.category,
      category_label: catalog.categoryLabel(result.category),
      sticker: publicSticker(result.sticker),
      sticker_remaining: inventory ? inventory.remaining(result.sticker.id) : null,
      exhausted_categories: catalog.exhaustedCategories.map((c) => c.id),
      source: result.source,
      fallback_type: result.fallback_type || null,
      fallback_reason: result.fallback_reason || null,
    };
  }

  return { generate };
}

module.exports = { createReadingService, validateDrawRequest, checkModelOutput, RequestError, FALLBACK_READINGS, pickWeightedCategory };
