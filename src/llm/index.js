'use strict';
const { createGeminiProvider } = require('./gemini');
const { createMockProvider } = require('./mock');

function createProvider(llmConfig) {
  switch (llmConfig.provider) {
    case 'gemini':
      return createGeminiProvider(llmConfig);
    case 'mock':
      return createMockProvider();
    default:
      throw new Error(`Unknown LLM_PROVIDER "${llmConfig.provider}"`);
  }
}

module.exports = { createProvider };
