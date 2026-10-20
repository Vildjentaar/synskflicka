'use strict';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Gemini provider using REST + JSON Schema structured output.
 * Returns the parsed JSON object; throws on transport, timeout or parse failure.
 */
function createGeminiProvider({ apiKey, model, temperature, timeoutMs }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  return {
    name: `gemini:${model}`,
    async generate({ system, user, schema }) {
      const effectiveTimeout = Number(process.env.GEMINI_TIMEOUT_MS) || Math.max(timeoutMs || 15000, 75000);

      const makeBody = (withThinkingBudget = true) => ({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature,
          responseMimeType: 'application/json',
          responseSchema: schema,
          maxOutputTokens: 2048,
          ...(withThinkingBudget ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      });

      let res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(makeBody(true)),
        signal: AbortSignal.timeout(effectiveTimeout),
      });

      // If thinkingConfig is not supported/accepted (HTTP 400), retry cleanly without it
      if (!res.ok && res.status === 400) {
        const errText = await res.text().catch(() => '');
        if (/thinking/i.test(errText)) {
          res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(makeBody(false)),
            signal: AbortSignal.timeout(effectiveTimeout),
          });
        } else {
          throw new Error(`Gemini HTTP 400: ${errText.slice(0, 300)}`);
        }
      }

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`Gemini HTTP ${res.status}: ${detail}`);
      }
      const data = await res.json();
      const candidate = data.candidates && data.candidates[0];
      const text = candidate && candidate.content && (candidate.content.parts || []).map((p) => p.text || '').join('');
      if (!text) throw new Error(`Gemini returned no content (finishReason: ${candidate && candidate.finishReason})`);
      return JSON.parse(text);
    },
  };
}

module.exports = { createGeminiProvider };
