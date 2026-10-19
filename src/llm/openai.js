'use strict';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/** Reasoning-style models (o-series, gpt-5*) reject `temperature` and `max_tokens`. */
const isReasoningModel = (model) => /^(o\d|gpt-5)/i.test(model);

/**
 * Converts the shared (Gemini-flavoured) response schema into an OpenAI strict-mode JSON Schema:
 * drops unsupported keywords (propertyOrdering) and forbids extra properties.
 */
function toOpenAISchema(schema) {
  const { propertyOrdering, ...rest } = schema; // eslint-disable-line no-unused-vars
  return { ...rest, additionalProperties: false };
}

/**
 * OpenAI provider using Chat Completions + Structured Outputs (json_schema, strict).
 * Returns the parsed JSON object; throws on transport, timeout, refusal or parse failure.
 */
function createOpenAIProvider({ apiKey, model, temperature, timeoutMs }) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const reasoning = isReasoningModel(model);

  return {
    name: `openai:${model}`,
    async generate({ system, user, schema }) {
      const body = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'tarot_reading', strict: true, schema: toOpenAISchema(schema) },
        },
        max_completion_tokens: reasoning ? 4096 : 2048,
      };
      if (!reasoning) body.temperature = temperature;

      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`OpenAI HTTP ${res.status}: ${detail}`);
      }
      const data = await res.json();
      const choice = data.choices && data.choices[0];
      const message = choice && choice.message;
      if (message && message.refusal) throw new Error(`OpenAI refused: ${message.refusal}`);
      const text = message && message.content;
      if (!text) throw new Error(`OpenAI returned no content (finish_reason: ${choice && choice.finish_reason})`);
      return JSON.parse(text);
    },
  };
}

module.exports = { createOpenAIProvider, toOpenAISchema };
