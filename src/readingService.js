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
  function fallbackResult(draw, reason, fallbackType = 'full_fallback') {
    const category = pick(catalog.enabledCategories, rng).id;
    const sticker = pick(catalog.stickersForCategory(category), rng);
    const names = draw.map((d) => (d.orientation === 'reversed' ? `${d.card.name} (ters)` : d.card.name));
    logger.warn(JSON.stringify({ event: 'reading_fallback', fallback_type: fallbackType, reason }));
    return { reading: FALLBACK_READINGS[category](names), category, sticker, source: 'fallback', fallback_type: fallbackType, fallback_reason: reason };
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
        result = fallbackResult(draw, `invalid model output: ${checked.issues.join('; ')}`, 'invalid_model_output');
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
      result = fallbackResult(draw, reason, fallbackType);
    }

    return {
      cards: draw.map((d) => ({ id: d.card.id, name: d.card.name, orientation: d.orientation })),
      reading_text: result.reading,
      category_id: result.category,
      category_label: catalog.categoryLabel(result.category),
      sticker: publicSticker(result.sticker),
      source: result.source,
      fallback_type: result.fallback_type || null,
      fallback_reason: result.fallback_reason || null,
    };
  }

  return { generate };
}

module.exports = { createReadingService, validateDrawRequest, checkModelOutput, RequestError, FALLBACK_READINGS };
