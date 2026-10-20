'use strict';
const { createGeminiProvider } = require('./gemini');
const { createOpenAIProvider } = require('./openai');
const { createGroqProvider } = require('./groq');
const { createMockProvider } = require('./mock');
const { createPipelineProvider } = require('./pipeline');

function createProvider(llmConfig) {
  const { temperature, timeoutMs } = llmConfig;
  switch (llmConfig.provider) {
    case 'pipeline':
    case 'groq':
      return createPipelineProvider(llmConfig);
    case 'groq-direct':
      return createGroqProvider({ ...llmConfig.groq, temperature, timeoutMs });
    case 'openai':
      return createOpenAIProvider({ ...llmConfig.openai, temperature, timeoutMs });
    case 'gemini':
      return createGeminiProvider({ ...llmConfig.gemini, temperature, timeoutMs });
    case 'mock':
      return createMockProvider();
    default:
      return createPipelineProvider(llmConfig);
  }
}

module.exports = { createProvider, createPipelineProvider };
