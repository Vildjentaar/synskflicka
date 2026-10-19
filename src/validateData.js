'use strict';
const fs = require('fs');
const path = require('path');

const SUITS = ['wands', 'cups', 'swords', 'pentacles'];
const TAG_FIELDS = ['expression', 'action', 'vibe_tags'];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Lowercase + strip diacritics (incl. Turkish dotless i) so "Ali Rıza" matches "ali_riza". */
function fold(s) {
  return String(s)
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'I')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Resolve "/stickers/x.png" to an absolute file path, refusing anything outside /stickers. */
function resolveAssetFile(assetRoot, assetPath) {
  if (typeof assetPath !== 'string' || !assetPath.startsWith('/stickers/')) return null;
  const stickersDir = path.join(assetRoot, 'stickers');
  const abs = path.normalize(path.join(assetRoot, assetPath));
  if (!abs.startsWith(stickersDir + path.sep)) return null;
  return abs;
}

function assetExists(assetRoot, assetPath) {
  const abs = resolveAssetFile(assetRoot, assetPath);
  return Boolean(abs && fs.existsSync(abs) && fs.statSync(abs).isFile());
}

function validateDeck(deck, errors) {
  if (!Array.isArray(deck)) {
    errors.push('deck: expected an array');
    return;
  }
  if (deck.length !== 78) errors.push(`deck: expected 78 cards, found ${deck.length}`);
  const ids = new Set();
  let majors = 0;
  const suitCounts = Object.fromEntries(SUITS.map((s) => [s, 0]));
  deck.forEach((c, i) => {
    const where = `deck[${i}]${c && c.id ? ` (${c.id})` : ''}`;
    if (!c || typeof c !== 'object') return errors.push(`${where}: not an object`);
    if (!isNonEmptyString(c.id)) errors.push(`${where}: missing id`);
    else if (ids.has(c.id)) errors.push(`${where}: duplicate id`);
    else ids.add(c.id);
    if (!isNonEmptyString(c.name)) errors.push(`${where}: missing name`);
    if (c.arcana === 'major') {
      majors++;
      if (c.suit !== null) errors.push(`${where}: major arcana must have suit null`);
    } else if (c.arcana === 'minor') {
      if (!SUITS.includes(c.suit)) errors.push(`${where}: invalid suit "${c.suit}"`);
      else suitCounts[c.suit]++;
    } else errors.push(`${where}: arcana must be "major" or "minor"`);
    if (c.rank === undefined || c.rank === null) errors.push(`${where}: missing rank`);
    for (const f of ['upright_meaning', 'reversed_meaning']) {
      if (!isStringArray(c[f]) || c[f].length === 0 || !c[f].every(isNonEmptyString)) {
        errors.push(`${where}: ${f} must be a non-empty array of strings`);
      }
    }
  });
  if (majors !== 22) errors.push(`deck: expected 22 major arcana, found ${majors}`);
  for (const s of SUITS) if (suitCounts[s] !== 14) errors.push(`deck: expected 14 ${s}, found ${suitCounts[s]}`);
}

function validateStickers({ stickers, vocab, assetRoot, strictAssets }, errors, warnings) {
  if (!Array.isArray(stickers)) {
    errors.push('stickers: expected an array');
    return;
  }
  const categoryIds = new Set(vocab.categories.map((c) => c.id));
  const statuses = new Set(vocab.annotation_statuses);
  const ids = new Map();
  const paths = new Map();

  stickers.forEach((s, i) => {
    const where = `sticker[${i}]${s && s.id ? ` (${s.id})` : ''}`;
    if (!s || typeof s !== 'object') return errors.push(`${where}: not an object`);

    // Required fields and types
    if (!isNonEmptyString(s.id)) errors.push(`${where}: id must be a non-empty string`);
    if (!isNonEmptyString(s.asset_path)) errors.push(`${where}: asset_path must be a non-empty string`);
    for (const f of ['franchise', 'character']) {
      if (!(f in s)) errors.push(`${where}: missing field ${f}`);
      else if (s[f] !== null && typeof s[f] !== 'string') errors.push(`${where}: ${f} must be a string or null`);
    }
    if (!isNonEmptyString(s.visual_description)) errors.push(`${where}: visual_description must be a non-empty string`);
    for (const f of [...TAG_FIELDS, 'secondary_categories', 'match_cues']) {
      if (!isStringArray(s[f])) errors.push(`${where}: ${f} must be an array of strings`);
    }
    if (isStringArray(s.match_cues) && s.match_cues.length === 0) warnings.push(`${where}: match_cues is empty`);
    if (!isNonEmptyString(s.primary_category)) errors.push(`${where}: primary_category must be a non-empty string`);
    if (!statuses.has(s.annotation_status)) errors.push(`${where}: annotation_status "${s.annotation_status}" is not allowed`);

    // Unique IDs and unique asset paths: a sticker ID must resolve to exactly one record and image.
    if (isNonEmptyString(s.id)) {
      if (ids.has(s.id)) errors.push(`${where}: duplicate id (also at index ${ids.get(s.id)})`);
      else ids.set(s.id, i);
    }
    if (isNonEmptyString(s.asset_path)) {
      if (paths.has(s.asset_path)) errors.push(`${where}: duplicate asset_path (also at index ${paths.get(s.asset_path)})`);
      else paths.set(s.asset_path, i);
    }

    // Categories
    if (isNonEmptyString(s.primary_category) && !categoryIds.has(s.primary_category)) {
      errors.push(`${where}: primary_category "${s.primary_category}" is not one of the five categories`);
    }
    if (isStringArray(s.secondary_categories)) {
      for (const c of s.secondary_categories) {
        if (!categoryIds.has(c)) errors.push(`${where}: secondary category "${c}" is not one of the five categories`);
        if (c === s.primary_category) warnings.push(`${where}: secondary_categories repeats the primary category "${c}"`);
      }
    }

    // Controlled vocabularies
    for (const f of TAG_FIELDS) {
      if (!isStringArray(s[f])) continue;
      const allowed = new Set(vocab[f]);
      for (const tag of s[f]) if (!allowed.has(tag)) errors.push(`${where}: ${f} tag "${tag}" is not in the approved vocabulary`);
    }

    // Asset path shape and existence
    if (isNonEmptyString(s.asset_path)) {
      if (!resolveAssetFile(assetRoot, s.asset_path)) {
        errors.push(`${where}: asset_path "${s.asset_path}" must live under /stickers/`);
      } else if (!assetExists(assetRoot, s.asset_path)) {
        (strictAssets ? errors : warnings).push(`${where}: asset file not found at ${s.asset_path}`);
      }
    }

    // Label consistency heuristic: the first token of the ID should appear in the character name.
    if (isNonEmptyString(s.id) && isNonEmptyString(s.character)) {
      const firstToken = fold(s.id).split('_')[0];
      if (firstToken && firstToken !== 'ai' && !fold(s.character).includes(firstToken)) {
        warnings.push(
          `${where}: MANUAL REVIEW - id/asset name starts with "${firstToken}" but character is "${s.character}". ` +
            'Verify the image and fix the wrong label intentionally; do not silently rename.'
        );
      }
    }
  });
}

function isEligible(sticker, { assetRoot, strictAssets }) {
  if (sticker.annotation_status !== 'approved') return false;
  if (strictAssets && !assetExists(assetRoot, sticker.asset_path)) return false;
  return true;
}

function validateCoverage({ stickers, vocab, assetRoot, strictAssets }, errors, warnings) {
  if (!Array.isArray(stickers)) return;
  const usable = stickers.filter((s) => s && isEligible(s, { assetRoot, strictAssets }));
  for (const cat of vocab.categories) {
    const primaries = usable.filter((s) => s.primary_category === cat.id).length;
    const secondaries = usable.filter((s) => (s.secondary_categories || []).includes(cat.id)).length;
    if (!cat.enabled) {
      warnings.push(`category ${cat.id}: disabled (${cat.disabled_reason || 'no reason given'}); ${primaries} primary / ${secondaries} secondary stickers`);
      continue;
    }
    if (primaries === 0) {
      errors.push(`category ${cat.id}: no usable approved sticker with this primary category`);
    } else if (primaries === 1) {
      warnings.push(`category ${cat.id}: only 1 primary sticker (+${secondaries} secondary) - low variety`);
    }
  }
  const notApproved = stickers.filter((s) => s && s.annotation_status !== 'approved').length;
  if (notApproved) warnings.push(`${notApproved} sticker(s) are not approved and will not be used`);
}

/**
 * Validate the deck, sticker catalog and vocabulary together.
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateData({ deck, stickers, vocab, assetRoot, strictAssets }) {
  const errors = [];
  const warnings = [];
  const enabled = (vocab.categories || []).filter((c) => c.enabled);
  if ((vocab.categories || []).length !== 5) errors.push('vocabulary: expected exactly five categories');
  if (enabled.length === 0) errors.push('vocabulary: no categories are enabled');
  validateDeck(deck, errors);
  validateStickers({ stickers, vocab, assetRoot, strictAssets }, errors, warnings);
  validateCoverage({ stickers, vocab, assetRoot, strictAssets }, errors, warnings);
  return { errors, warnings };
}

module.exports = { validateData, isEligible, assetExists, resolveAssetFile };
