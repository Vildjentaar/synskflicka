#!/usr/bin/env node
'use strict';
// Quality evaluation (plan 6.3). Generates N readings with random draws through the real
// reading service and reports category balance, sticker spread, fallbacks and sample output.
// Usage: node scripts/eval-readings.js [count=15] [--out results.json]
const fs = require('fs');
const config = require('../src/config');
const { loadCatalog } = require('../src/catalog');
const { createProvider } = require('../src/llm');
const { createReadingService } = require('../src/readingService');
const { shuffled } = require('../src/prompt');

const count = parseInt(process.argv[2], 10) || 15;
const outIdx = process.argv.indexOf('--out');
const outFile = outIdx > -1 ? process.argv[outIdx + 1] : null;

const issues = [];
const logger = { info() {}, warn: (m) => issues.push(m), error: (m) => issues.push(m) };
const catalog = loadCatalog();
const provider = createProvider(config.llm);
const service = createReadingService({ catalog, provider, limits: config.reading, logger });

(async () => {
  console.log(`Evaluating ${count} readings with ${provider.name}\n`);
  const results = [];
  for (let i = 0; i < count; i++) {
    const cards = shuffled(catalog.deck).slice(0, 3).map((c) => ({ id: c.id, orientation: Math.random() < 0.35 ? 'reversed' : 'upright' }));
    const r = await service.generate({ cards });
    results.push(r);
    const draw = r.cards.map((c) => `${c.name}${c.orientation === 'reversed' ? ' (R)' : ''}`).join(' / ');
    console.log(`#${i + 1} [${r.source}] ${draw}\n   -> ${r.category_id} | ${r.sticker.id}\n   ${r.reading_text}\n`);
  }

  const tally = (key) =>
    results.reduce((m, r) => ((m[key(r)] = (m[key(r)] || 0) + 1), m), {});
  const cats = tally((r) => r.category_id);
  const stickers = tally((r) => r.sticker.id);
  const sources = tally((r) => r.source);

  console.log('=== Category distribution ===');
  for (const c of catalog.enabledCategories) console.log(`  ${c.id.padEnd(20)} ${cats[c.id] || 0}`);
  const missing = catalog.enabledCategories.filter((c) => !cats[c.id]).map((c) => c.id);
  if (missing.length) console.log(`  ! never chosen: ${missing.join(', ')}`);

  console.log('\n=== Sticker usage ===');
  Object.entries(stickers).sort((a, b) => b[1] - a[1]).forEach(([id, n]) => console.log(`  ${String(n).padStart(3)}  ${id}`));
  console.log(`  ${catalog.eligibleStickers.length - Object.keys(stickers).length} of ${catalog.eligibleStickers.length} eligible stickers never used`);

  console.log('\n=== Sources ===');
  Object.entries(sources).forEach(([s, n]) => console.log(`  ${s.padEnd(22)} ${n}`));
  if (issues.length) {
    console.log('\n=== Validation/LLM issues ===');
    issues.forEach((m) => console.log(`  ${m}`));
  }
  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
    console.log(`\nSaved raw results to ${outFile} for hand review.`);
  }
})();
