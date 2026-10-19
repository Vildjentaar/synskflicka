'use strict';
const { createGeminiProvider } = require('./gemini');
const { createOpenAIProvider } = require('./openai');
const { createGroqProvider } = require('./groq');
const { createMockProvider } = require('./mock');

function createProvider(llmConfig) {
  const { temperature, timeoutMs } = llmConfig;
  switch (llmConfig.provider) {
    case 'groq':
      return createGroqProvider({ ...llmConfig.groq, temperature, timeoutMs });
    case 'openai':
      return createOpenAIProvider({ ...llmConfig.openai, temperature, timeoutMs });
    case 'gemini':
      return createGeminiProvider({ ...llmConfig.gemini, temperature, timeoutMs });
    case 'mock':
      return createMockProvider();
    default:
      throw new Error(`Unknown LLM_PROVIDER "${llmConfig.provider}"`);
  }
}

module.exports = { createProvider };
