'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PipelineProvider, GroqWindowTracker, parseDurationToMs } = require('../src/llm/pipeline');
const { createReadingService } = require('../src/readingService');
const { loadCatalog } = require('../src/catalog');

const silent = { info() {}, warn() {}, error() {} };
const catalog = loadCatalog({ strictAssets: false });

const DRAW = {
  cards: [
    { id: 'the_fool', orientation: 'upright' },
    { id: 'the_tower', orientation: 'reversed' },
    { id: 'three_of_cups', orientation: 'upright' },
  ],
};

function createMockStage(id, name, isGroq = false) {
  let callCount = 0;
  let fail = false;
  let failError = new Error(`${name} failed`);

  return {
    id,
    name,
    isGroq,
    getCallCount: () => callCount,
    setFail: (shouldFail, err) => {
      fail = shouldFail;
      if (err) failError = err;
    },
    provider: {
      name,
      async generate() {
        callCount++;
        if (fail) throw failError;
        return {
          reading_text: `Reading by ${name}. The Fool guides you forward.`,
          category_id: 'cynical_observer',
          sticker_id: 'kevin_malone_smirk',
        };
      },
    },
  };
}

describe('Groq duration parser', () => {
  test('parses seconds, minutes, hours, and milliseconds accurately', () => {
    assert.equal(parseDurationToMs('45s'), 45000);
    assert.equal(parseDurationToMs('2m'), 120000);
    assert.equal(parseDurationToMs('2m59.56s'), 179560);
    assert.equal(parseDurationToMs('1h'), 3600000);
    assert.equal(parseDurationToMs('1h30m15s'), 5415000);
    assert.equal(parseDurationToMs('250ms'), 250);
    assert.equal(parseDurationToMs(''), 0);
    assert.equal(parseDurationToMs(null), 0);
  });
});

describe('GroqWindowTracker', () => {
  test('tracks remaining time from x-ratelimit-reset-requests on 429', () => {
    const tracker = new GroqWindowTracker();
    assert.equal(tracker.getRemainingMs(), 0);

    tracker.updateFromHeaders({ 'x-ratelimit-reset-requests': '2m' }, 429);
    const remaining = tracker.getRemainingMs();
    assert.ok(remaining > 110000 && remaining <= 120000);
  });

  test('tracks remaining time from retry-after header', () => {
    const tracker = new GroqWindowTracker();
    tracker.updateFromHeaders({ 'retry-after': '30' }, 429);
    const remaining = tracker.getRemainingMs();
    assert.ok(remaining > 28000 && remaining <= 30000);
  });

  test('tracks remaining time from x-ratelimit-reset-tokens on 429', () => {
    const tracker = new GroqWindowTracker();
    tracker.updateFromHeaders({ 'x-ratelimit-reset-tokens': '14m32.208s' }, 429);
    const remaining = tracker.getRemainingMs();
    assert.ok(remaining > 870000 && remaining <= 872500);
  });

  test('extracts duration from Groq TPD error message text', () => {
    const tracker = new GroqWindowTracker();
    const errorMsg =
      'Rate limit reached for model `openai/gpt-oss-20b` ... on tokens per day (TPD): Limit 200000. Please try again in 14m32.208s.';
    tracker.updateFromHeaders(null, 429, errorMsg);
    const remaining = tracker.getRemainingMs();
    assert.ok(remaining > 870000 && remaining <= 872500);
  });

  test('setRemainingMs overrides directly for tests', () => {
    const tracker = new GroqWindowTracker();
    tracker.setRemainingMs(45000); // 45s (< 1 min)
    assert.ok(tracker.getRemainingMs() <= 45000 && tracker.getRemainingMs() > 44000);
  });
});

describe('LLM Switch Pipeline Order & Fallback', () => {
  test('default starts at GPT-OSS (GROQ)', () => {
    const stage0 = createMockStage('gpt-oss-groq', 'GPT-OSS (GROQ)', true);
    const stage1 = createMockStage('llama', 'LLAMA', true);
    const stage2 = createMockStage('gpt-4o-mini', 'GPT-4O-MINI', false);
    const stage3 = createMockStage('gemini-3.8-flash', 'GEMINI-3.8-flash', false);

    const pipeline = new PipelineProvider({
      stages: [stage0, stage1, stage2, stage3],
      logger: silent,
    });

    assert.equal(pipeline.currentIndex, 0);
    assert.equal(pipeline.currentStage.name, 'GPT-OSS (GROQ)');
  });

  test('success keeps the active provider at GPT-OSS (GROQ)', async () => {
    const stage0 = createMockStage('gpt-oss-groq', 'GPT-OSS (GROQ)', true);
    const stage1 = createMockStage('llama', 'LLAMA', true);
    const stage2 = createMockStage('gpt-4o-mini', 'GPT-4O-MINI', false);
    const stage3 = createMockStage('gemini-3.8-flash', 'GEMINI-3.8-flash', false);

    const pipeline = new PipelineProvider({
      stages: [stage0, stage1, stage2, stage3],
      logger: silent,
    });

    const res = await pipeline.generate({ system: 'sys', user: 'u', schema: {} });
    assert.ok(res.reading_text.includes('GPT-OSS (GROQ)'));
    assert.equal(stage0.getCallCount(), 1);
    assert.equal(stage1.getCallCount(), 0);
    assert.equal(pipeline.currentIndex, 0);
  });

  test('failure switches to next LLM in line and reading service falls back to pre-set reading', async () => {
    const stage0 = createMockStage('gpt-oss-groq', 'GPT-OSS (GROQ)', true);
    const stage1 = createMockStage('llama', 'LLAMA', true);
    const stage2 = createMockStage('gpt-4o-mini', 'GPT-4O-MINI', false);
    const stage3 = createMockStage('gemini-3.8-flash', 'GEMINI-3.8-flash', false);

    const tracker = new GroqWindowTracker();
    // Simulate Groq daily quota exhausted with 2 hours remaining (> 1m)
    tracker.setRemainingMs(2 * 3600 * 1000);

    const pipeline = new PipelineProvider({
      stages: [stage0, stage1, stage2, stage3],
      tracker,
      logger: silent,
    });

    const service = createReadingService({
      catalog,
      provider: pipeline,
      limits: { maxWords: 150 },
      logger: silent,
    });

    // 1. Stage 0 fails
    stage0.setFail(true, new Error('Groq 429 Rate Limit'));
    const reading1 = await service.generate(DRAW);

    // Current call fell back to a pre-set reading
    assert.equal(reading1.source, 'fallback');
    assert.ok(reading1.reading_text.length > 0);
    // Pipeline switched to Stage 1: LLAMA
    assert.equal(pipeline.currentIndex, 1);
    assert.equal(pipeline.currentStage.name, 'LLAMA');

    // 2. Next call: attempts LLAMA
    const reading2 = await service.generate(DRAW);
    assert.equal(reading2.source, 'llm');
    assert.ok(reading2.reading_text.includes('LLAMA'));
    assert.equal(stage1.getCallCount(), 1);
    assert.equal(pipeline.currentIndex, 1);

    // 3. Stage 1 fails: switches to GPT-4O-MINI
    stage1.setFail(true, new Error('Llama failed'));
    const reading3 = await service.generate(DRAW);
    assert.equal(reading3.source, 'fallback');
    assert.equal(pipeline.currentIndex, 2);
    assert.equal(pipeline.currentStage.name, 'GPT-4O-MINI');

    // 4. Next call: attempts GPT-4O-MINI
    const reading4 = await service.generate(DRAW);
    assert.equal(reading4.source, 'llm');
    assert.ok(reading4.reading_text.includes('GPT-4O-MINI'));
    assert.equal(stage2.getCallCount(), 1);
    assert.equal(pipeline.currentIndex, 2);

    // 5. Stage 2 fails: switches to GEMINI-3.8-flash
    stage2.setFail(true, new Error('OpenAI failed'));
    const reading5 = await service.generate(DRAW);
    assert.equal(reading5.source, 'fallback');
    assert.equal(pipeline.currentIndex, 3);
    assert.equal(pipeline.currentStage.name, 'GEMINI-3.8-flash');

    // 6. Next call: attempts GEMINI-3.8-flash
    const reading6 = await service.generate(DRAW);
    assert.equal(reading6.source, 'llm');
    assert.ok(reading6.reading_text.includes('GEMINI-3.8-flash'));
    assert.equal(stage3.getCallCount(), 1);
  });
});

describe('Groq Daily Window Counter Reset Logic', () => {
  test('when current LLM is not Groq and Groq window >= 1m, continues in order', async () => {
    const stage0 = createMockStage('gpt-oss-groq', 'GPT-OSS (GROQ)', true);
    const stage1 = createMockStage('llama', 'LLAMA', true);

    const tracker = new GroqWindowTracker();
    // Groq window has 5 minutes remaining (>= 1m)
    tracker.setRemainingMs(5 * 60 * 1000);

    const pipeline = new PipelineProvider({
      stages: [stage0, stage1],
      tracker,
      logger: silent,
    });

    // Manually put current LLM at stage 1 (LLAMA)
    pipeline.currentIndex = 1;

    const res = await pipeline.generate({ system: 'sys', user: 'u', schema: {} });
    assert.ok(res.reading_text.includes('LLAMA'));
    assert.equal(pipeline.currentIndex, 1);
    assert.equal(stage0.getCallCount(), 0);
    assert.equal(stage1.getCallCount(), 1);
  });

  test('when current LLM is not Groq and Groq window < 1m, switches back to Groq and resets order', async () => {
    const stage0 = createMockStage('gpt-oss-groq', 'GPT-OSS (GROQ)', true);
    const stage1 = createMockStage('llama', 'LLAMA', true);
    const stage2 = createMockStage('gpt-4o-mini', 'GPT-4O-MINI', false);

    const tracker = new GroqWindowTracker();
    // Groq window counter has 45 seconds remaining (< 1m)
    tracker.setRemainingMs(45 * 1000);

    const pipeline = new PipelineProvider({
      stages: [stage0, stage1, stage2],
      tracker,
      logger: silent,
    });

    // Currently at stage 2 (GPT-4O-MINI)
    pipeline.currentIndex = 2;

    const res = await pipeline.generate({ system: 'sys', user: 'u', schema: {} });
    // Should have switched back to Groq and executed with Groq!
    assert.ok(res.reading_text.includes('GPT-OSS (GROQ)'));
    assert.equal(pipeline.currentIndex, 0);
    assert.equal(stage0.getCallCount(), 1);
    assert.equal(stage2.getCallCount(), 0);
  });

  test('when current LLM is not Groq and Groq window has expired (0ms), switches back to Groq', async () => {
    const stage0 = createMockStage('gpt-oss-groq', 'GPT-OSS (GROQ)', true);
    const stage1 = createMockStage('llama', 'LLAMA', true);

    const tracker = new GroqWindowTracker();
    tracker.setRemainingMs(0); // 0s (< 1m)

    const pipeline = new PipelineProvider({
      stages: [stage0, stage1],
      tracker,
      logger: silent,
    });

    pipeline.currentIndex = 1;

    const res = await pipeline.generate({ system: 'sys', user: 'u', schema: {} });
    assert.ok(res.reading_text.includes('GPT-OSS (GROQ)'));
    assert.equal(pipeline.currentIndex, 0);
    assert.equal(stage0.getCallCount(), 1);
  });
});
