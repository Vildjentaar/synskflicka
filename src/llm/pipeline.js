'use strict';
const { createGroqProvider } = require('./groq');
const { createOpenAIProvider } = require('./openai');
const { createGeminiProvider } = require('./gemini');

/**
 * Parses Groq duration string (e.g. "2m59.56s", "45s", "1h20m", "500ms") into milliseconds.
 */
function parseDurationToMs(str) {
  if (!str || typeof str !== 'string') return 0;
  let totalMs = 0;
  const d = str.match(/(\d+(?:\.\d+)?)d/);
  if (d) totalMs += parseFloat(d[1]) * 86400 * 1000;
  const h = str.match(/(\d+(?:\.\d+)?)h/);
  if (h) totalMs += parseFloat(h[1]) * 3600 * 1000;
  const m = str.match(/(\d+(?:\.\d+)?)m(?!s)/);
  if (m) totalMs += parseFloat(m[1]) * 60 * 1000;
  const s = str.match(/(\d+(?:\.\d+)?)s/);
  if (s) totalMs += parseFloat(s[1]) * 1000;
  const ms = str.match(/(\d+(?:\.\d+)?)ms/);
  if (ms) totalMs += parseFloat(ms[1]);
  return Math.round(totalMs);
}

/**
 * Tracks Groq's daily request rate-limit window counter.
 * Reads x-ratelimit-reset-requests / retry-after headers from Groq responses.
 */
class GroqWindowTracker {
  constructor() {
    this.resetAt = 0;
    this.lastResetString = null;
    this.lastStatus = null;
  }

  updateFromHeaders(headers, status = null, errorMessage = null) {
    this.lastStatus = status;

    let resetTokens = null;
    let resetRequests = null;
    let retryAfter = null;

    if (headers) {
      resetTokens = typeof headers.get === 'function'
        ? headers.get('x-ratelimit-reset-tokens')
        : headers['x-ratelimit-reset-tokens'];
      resetRequests = typeof headers.get === 'function'
        ? headers.get('x-ratelimit-reset-requests')
        : headers['x-ratelimit-reset-requests'];
      retryAfter = typeof headers.get === 'function'
        ? headers.get('retry-after')
        : headers['retry-after'];
    }

    const tokenMs = resetTokens ? parseDurationToMs(resetTokens) : 0;
    const requestMs = resetRequests ? parseDurationToMs(resetRequests) : 0;
    const retryMs = retryAfter ? (parseFloat(retryAfter) || 0) * 1000 : 0;

    let maxMs = Math.max(tokenMs, requestMs, retryMs);

    // If headers didn't provide duration, inspect the error message text (e.g. "Please try again in 14m32.208s.")
    if (maxMs === 0 && errorMessage && typeof errorMessage === 'string') {
      const match = errorMessage.match(/try again in ([0-9]+[a-z0-9.]+)/i);
      if (match && match[1]) {
        maxMs = parseDurationToMs(match[1]);
        this.lastResetString = match[1];
      }
    }

    if (maxMs > 0) {
      if (status === 429 || status >= 400 || (errorMessage && errorMessage.includes('429'))) {
        this.resetAt = Date.now() + maxMs;
        this.lastResetString = resetTokens || resetRequests || (retryAfter ? `${retryAfter}s` : this.lastResetString);
      }
    } else if (status === 429 || (errorMessage && errorMessage.includes('429'))) {
      // Default to 15 minutes if 429 occurred with no extractable duration
      this.resetAt = Date.now() + 15 * 60 * 1000;
      this.lastResetString = '15m';
    }
  }

  getRemainingMs() {
    if (!this.resetAt || this.resetAt <= Date.now()) return 0;
    return Math.max(0, this.resetAt - Date.now());
  }

  setRemainingMs(ms) {
    this.resetAt = Date.now() + Math.max(0, ms);
  }

  reset() {
    this.resetAt = 0;
    this.lastResetString = null;
    this.lastStatus = null;
  }
}

/**
 * LLM Pipeline Provider
 * Sequence: GPT-OSS (GROQ) -> LLAMA -> GPT-4O-MINI -> GEMINI-3.8-flash
 *
 * Rules:
 * 1. Default is Groq (Stage 0).
 * 2. If an LLM call fails, rethrow so the system falls back to a pre-set reading,
 *    and switch to the next LLM in line for the next call.
 * 3. If current LLM is not Groq, check only Groq's daily window counter.
 *    If it is less than 1 minute (< 60,000 ms), switch back to Groq and reset the LLM switch order.
 *    If not, continue in order.
 */
class PipelineProvider {
  constructor({ stages, tracker, groqWindowChecker, logger = console } = {}) {
    this.stages = stages || [];
    this.currentIndex = 0;
    this.tracker = tracker || new GroqWindowTracker();
    this.groqWindowChecker = groqWindowChecker || null;
    this.logger = logger;
    this.lastFailedCall = false;
  }

  get name() {
    const current = this.stages[this.currentIndex];
    return current ? `pipeline:${current.name}` : 'pipeline:none';
  }

  get currentStage() {
    return this.stages[this.currentIndex] || null;
  }

  async getGroqDailyWindowRemainingMs() {
    if (typeof this.groqWindowChecker === 'function') {
      return await this.groqWindowChecker();
    }
    return this.tracker.getRemainingMs();
  }

  async checkAndApplyGroqWindowReset() {
    // Only check if current LLM is not Groq (index !== 0)
    if (this.currentIndex !== 0) {
      const remainingMs = await this.getGroqDailyWindowRemainingMs();
      if (remainingMs < 60 * 1000) {
        this.logger.info(
          `[pipeline] Groq daily window counter is ${Math.round(remainingMs / 1000)}s (< 1 min). Switching back to Groq and resetting LLM switch order.`
        );
        this.currentIndex = 0;
      }
    }
  }

  async generate({ system, user, schema }) {
    if (!this.stages.length) {
      throw new Error('No LLM stages configured in pipeline');
    }

    // Check Groq's daily window counter before generating if not on Groq
    await this.checkAndApplyGroqWindowReset();

    const currentStage = this.stages[this.currentIndex];
    this.lastFailedCall = false;

    try {
      const raw = await currentStage.provider.generate({ system, user, schema });
      return raw;
    } catch (err) {
      // Capture rate limit headers from Groq if available
      if (currentStage.isGroq) {
        const detail = err.detail || err.message;
        this.tracker.updateFromHeaders(err.headers, err.status || 429, detail);
      }

      const prevStage = currentStage.name;
      // Switch to the next LLM in line
      this.currentIndex = (this.currentIndex + 1) % this.stages.length;
      const nextStage = this.stages[this.currentIndex].name;
      this.lastFailedCall = true;

      this.logger.warn(
        `[pipeline] LLM call to ${prevStage} failed (${err.message}). Switched to next LLM: ${nextStage}.`
      );

      // Re-throw so readingService provides the pre-set fallback reading
      throw err;
    }
  }

  /** Explicitly report failure (e.g. from invalid model output parsing) */
  reportFailure(reason = 'unknown') {
    if (!this.lastFailedCall) {
      const prevStage = this.stages[this.currentIndex].name;
      this.currentIndex = (this.currentIndex + 1) % this.stages.length;
      const nextStage = this.stages[this.currentIndex].name;
      this.logger.warn(
        `[pipeline] LLM output failure from ${prevStage} (${reason}). Switched to next LLM: ${nextStage}.`
      );
      this.lastFailedCall = true;
    }
  }

  resetOrder() {
    this.currentIndex = 0;
  }
}

/**
 * Creates the full production pipeline:
 * GPT-OSS (GROQ) -> LLAMA -> GPT-4O-MINI -> GEMINI-3.8-flash
 */
function createPipelineProvider(llmConfig = {}, options = {}) {
  const { temperature, timeoutMs } = llmConfig;
  const tracker = options.tracker || new GroqWindowTracker();
  const logger = options.logger || console;

  if (options.stages) {
    return new PipelineProvider({ stages: options.stages, tracker, groqWindowChecker: options.groqWindowChecker, logger });
  }

  const groqApiKey = (llmConfig.groq && llmConfig.groq.apiKey) || process.env.GROQ_API_KEY || '';
  const groqGptOssModel = (llmConfig.groq && llmConfig.groq.model) || process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
  const groqLlamaModel =
    (llmConfig.groq && llmConfig.groq.llamaModel) ||
    process.env.LLAMA_MODEL ||
    process.env.GROQ_LLAMA_MODEL ||
    'llama-3.3-70b-versatile';

  const openaiApiKey = (llmConfig.openai && llmConfig.openai.apiKey) || process.env.OPENAI_API_KEY || '';
  const openaiModel = (llmConfig.openai && llmConfig.openai.model) || process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const geminiApiKey = (llmConfig.gemini && llmConfig.gemini.apiKey) || process.env.GEMINI_API_KEY || '';
  const geminiModel = (llmConfig.gemini && llmConfig.gemini.model) || process.env.GEMINI_MODEL || 'gemini-3.8-flash';

  const stages = [
    {
      id: 'gpt-oss-groq',
      name: 'GPT-OSS (GROQ)',
      isGroq: true,
      provider: createGroqProvider({
        apiKey: groqApiKey,
        model: groqGptOssModel,
        temperature,
        timeoutMs,
        tracker,
      }),
    },
    {
      id: 'llama',
      name: 'LLAMA',
      isGroq: true,
      provider: createGroqProvider({
        apiKey: groqApiKey,
        model: groqLlamaModel,
        temperature,
        timeoutMs,
        tracker,
      }),
    },
    {
      id: 'gpt-4o-mini',
      name: 'GPT-4O-MINI',
      isGroq: false,
      provider: createOpenAIProvider({
        apiKey: openaiApiKey,
        model: openaiModel,
        temperature,
        timeoutMs,
      }),
    },
    {
      id: 'gemini-3.8-flash',
      name: 'GEMINI-3.8-flash',
      isGroq: false,
      provider: createGeminiProvider({
        apiKey: geminiApiKey,
        model: geminiModel,
        temperature,
        timeoutMs,
      }),
    },
  ];

  return new PipelineProvider({
    stages,
    tracker,
    groqWindowChecker: options.groqWindowChecker,
    logger,
  });
}

module.exports = {
  createPipelineProvider,
  PipelineProvider,
  GroqWindowTracker,
  parseDurationToMs,
};
