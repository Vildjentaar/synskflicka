'use strict';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/** Models on Groq that support `response_format: json_schema` (constrained decoding). */
const JSON_SCHEMA_MODELS = /^(openai\/gpt-oss-|moonshotai\/kimi-k2|meta-llama\/llama-4-)/i;
/** gpt-oss models spend completion tokens on reasoning, so they need more headroom. */
const REASONING_MODELS = /^openai\/gpt-oss-/i;

function toGroqSchema(schema) {
  const { propertyOrdering, ...rest } = schema; // eslint-disable-line no-unused-vars
  return { ...rest, additionalProperties: false };
}

/**
 * Groq provider (OpenAI-compatible Chat Completions).
 * Uses json_schema structured output where the model supports it, otherwise falls back to
 * json_object mode with the schema described in the system prompt.
 * Returns the parsed JSON object; throws on transport, timeout or parse failure.
 */
function createGroqProvider({ apiKey, model, temperature, timeoutMs }) {
  if (!apiKey) throw new Error('GROQ_API_KEY is not set');
  const supportsSchema = JSON_SCHEMA_MODELS.test(model);
  const reasoning = REASONING_MODELS.test(model);

  return {
    name: `groq:${model}`,
    async generate({ system, user, schema }) {
      const groqSchema = toGroqSchema(schema);
      const sys = supportsSchema
        ? system
        : `${system}\n\nReturn a single JSON object that conforms to this JSON Schema:\n${JSON.stringify(groqSchema)}`;

      const body = {
        model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        response_format: supportsSchema
          ? { type: 'json_schema', json_schema: { name: 'tarot_reading', strict: false, schema: groqSchema } }
          : { type: 'json_object' },
        temperature,
        max_completion_tokens: reasoning ? 4096 : 2048,
      };
      if (reasoning) body.reasoning_effort = 'low';

      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`Groq HTTP ${res.status}: ${detail}`);
      }
      const data = await res.json();
      const choice = data.choices && data.choices[0];
      const text = choice && choice.message && choice.message.content;
      if (!text) throw new Error(`Groq returned no content (finish_reason: ${choice && choice.finish_reason})`);
      return JSON.parse(text);
    },
  };
}

module.exports = { createGroqProvider };
