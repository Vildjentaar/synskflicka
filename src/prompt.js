'use strict';

/** Fisher-Yates shuffle (copy). Used to reduce position bias when listing stickers. */
function shuffled(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildSystemPrompt(catalog) {
  const categories = catalog.enabledCategories.map((c) => `- ${c.id}: ${c.definition}`).join('\n');
  return `You are a witty, lighthearted tarot reader at a festival booth. Someone has drawn three cards and wants to know about their energy TODAY.

YOUR TASKS (all in one response):
1. Write "reading_text": a playful reading of 3-4 sentences, STRICTLY between 300 and 400 characters in total (including spaces and punctuation; aim for about 350), written in natural, idiomatic, conversational Turkish (address the person informally as "sen"; keep the humor and wordplay feeling native, not translated). Card names are given in Turkish; use them exactly as listed.
   - Actually interpret all three cards and their orientations; weave them together rather than listing them.
   - Focus strictly on the person's energy and the small, everyday things they might run into today.
   - Use hedged, playful language (Turkish equivalents of "the cards suggest", "you may", "watch out for", e.g. "kartlar gösteriyor ki", "olabilir", "dikkat et") - never present anything as a guaranteed prediction.
   - No long-term fortunes, nothing ominous or fear-inducing, no health, medical, financial, legal, or relationship-ending advice. Keep it low-stakes entertainment.
   - Do not mention category names, sticker IDs, or that a sticker will be shown.
   - The reading MUST connect to the theme of the category you choose in step 2, whether closely or loosely (a direct nod or a subtle wink): let the category's mood, behavior, or situation shape the imagery, tone, and everyday scenarios of the reading. Never say the category name or its exact wording; the link should be felt, not labeled. Decide the category first, then write the reading to fit it.
2. Choose "category_id": exactly one comedic archetype that best fits the three cards drawn (it is also the theme your reading must echo, see above). These are comedic tones, not personality diagnoses:
${categories}
3. Choose "sticker_id": the ONE sticker from the catalog that best matches the specific situation and tone of your reading.
   - Match on the actual annotations (visual description, expression, action, vibe tags, match cues) - not on how famous the character is.
   - Strongly prefer stickers whose primary_category equals your category_id.
   - Only pick a sticker whose secondary_categories contains your category_id when it is a clearly stronger semantic fit than every primary match.
   - Never pick a sticker that lists neither your category as primary nor as secondary.
   - Use only sticker IDs that appear in the catalog, copied exactly.

Respond only with the JSON object required by the response schema.`;
}

function describeCard(card, orientation, position) {
  const meanings = orientation === 'reversed' ? card.reversed_meaning : card.upright_meaning;
  return `${position}. ${card.name} (${orientation}) - ${meanings.join(', ')}`;
}

function compactSticker(s, enabledIds) {
  return {
    id: s.id,
    visual_description: s.visual_description,
    expression: s.expression,
    action: s.action,
    vibe_tags: s.vibe_tags,
    primary_category: s.primary_category,
    secondary_categories: s.secondary_categories.filter((c) => enabledIds.has(c)),
    match_cues: s.match_cues,
  };
}

/**
 * Builds the user turn. Only server-side canonical data goes in here - never client text.
 * @param {Array<{card: object, orientation: string}>} draw
 */
function buildUserPrompt(catalog, draw, { date = new Date(), rng } = {}) {
  const enabledIds = new Set(catalog.enabledCategories.map((c) => c.id));
  const weekday = date.toLocaleDateString('tr-TR', { weekday: 'long' });
  const stickers = shuffled(catalog.eligibleStickers, rng).map((s) => compactSticker(s, enabledIds));
  return `Bugün gün: ${weekday}.

THE DRAW:
${draw.map((d, i) => describeCard(d.card, d.orientation, i + 1)).join('\n')}

STICKER CATALOG (JSON):
${JSON.stringify(stickers)}`;
}

/** Structured-output schema. Enums are generated from the live catalog at request time. */
function buildResponseSchema(catalog) {
  return {
    type: 'object',
    properties: {
      category_id: { type: 'string', enum: catalog.enabledCategories.map((c) => c.id) },
      reading_text: { type: 'string', description: 'Bugün hakkında Türkçe, eğlenceli, 3-4 cümlelik, boşluklar dahil 300-400 karakterlik bir yorum; seçilen kategorinin temasına (adını anmadan) bağlanır.' },
      sticker_id: { type: 'string', enum: catalog.eligibleStickers.map((s) => s.id) },
    },
    required: ['category_id', 'reading_text', 'sticker_id'],
    propertyOrdering: ['category_id', 'reading_text', 'sticker_id'],
  };
}

module.exports = { buildSystemPrompt, buildUserPrompt, buildResponseSchema, shuffled };
