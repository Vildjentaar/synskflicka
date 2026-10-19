#!/usr/bin/env node
'use strict';
// Usage: node scripts/validate-data.js [--strict]
// Exit code 1 when any error is found. Warnings never fail the run.
const fs = require('fs');
const config = require('../src/config');
const { validateData } = require('../src/validateData');

const strictAssets = process.argv.includes('--strict') || config.strictAssets;
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

let result;
try {
  result = validateData({
    deck: read(config.paths.deck),
    stickers: read(config.paths.stickers),
    vocab: read(config.paths.vocabulary),
    assetRoot: config.paths.assetRoot,
    strictAssets,
  });
} catch (e) {
  console.error(`Could not read data files: ${e.message}`);
  process.exit(1);
}

const { errors, warnings } = result;
console.log(`Data validation (strict assets: ${strictAssets})`);
if (warnings.length) {
  console.log(`\nWarnings (${warnings.length}):`);
  warnings.forEach((w) => console.log(`  ! ${w}`));
}
if (errors.length) {
  console.log(`\nErrors (${errors.length}):`);
  errors.forEach((e) => console.log(`  x ${e}`));
  process.exit(1);
}
console.log('\nOK - no blocking errors.');
