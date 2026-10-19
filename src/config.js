'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const env = process.env;
const isProduction = env.NODE_ENV === 'production';

const bool = (v, fallback) => (v === undefined || v === '' ? fallback : /^(1|true|yes)$/i.test(v));
const int = (v, fallback) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : fallback);

const config = {
  root: ROOT,
  isProduction,
  port: int(env.PORT, 3000),
  paths: {
    deck: path.join(ROOT, 'data', 'tarot_cards.json'),
    stickers: path.join(ROOT, 'data', 'stickers.json'),
    vocabulary: path.join(ROOT, 'config', 'vocabulary.json'),
    // asset_path values look like "/stickers/foo.png" and resolve against this directory.
    assetRoot: ROOT,
    public: path.join(ROOT, 'public'),
  },
  strictAssets: bool(env.STRICT_ASSETS, false),
  llm: {
    // "groq" | "openai" | "gemini" | "mock". Defaults to whichever provider has an API key (Groq, OpenAI, Gemini).
    provider: (
      env.LLM_PROVIDER ||
      (env.GROQ_API_KEY ? 'groq' : env.OPENAI_API_KEY ? 'openai' : env.GEMINI_API_KEY ? 'gemini' : 'mock')
    ).toLowerCase(),
    groq: {
      apiKey: env.GROQ_API_KEY || '',
      model: env.GROQ_MODEL || 'openai/gpt-oss-20b',
    },
    openai: {
      apiKey: env.OPENAI_API_KEY || '',
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
    },
    gemini: {
      apiKey: env.GEMINI_API_KEY || '',
      model: env.GEMINI_MODEL || 'gemini-3.8-flash',
    },
    temperature: Number.isFinite(parseFloat(env.LLM_TEMPERATURE)) ? parseFloat(env.LLM_TEMPERATURE) : 0.7,
    timeoutMs: int(env.LLM_TIMEOUT_MS, 15000),
  },
  rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 20),
  reading: {
    // Prompt asks for 300-400 chars; validation allows ~10% slack because LLMs miscount characters.
    minChars: 280,
    maxChars: 420,
    minSentences: 2,
    maxSentences: 6,
  },
};

module.exports = config;
