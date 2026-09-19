'use strict';

// Thrown when an LLM call never produces valid, schema-conforming JSON
// after one retry. Named (not just .name-tagged) AI_FAILED so a Step
// Functions Catch on ["AI_FAILED"] matches this error's errorType
// regardless of whether the runtime derives that from the constructor
// name or the .name property — see CLAUDE.md: "mark the run AI_FAILED —
// never silently switch models or providers mid-run."
class AI_FAILED extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'AI_FAILED';
    if (cause) this.cause = cause;
  }
}

// Minimal JSON-Schema-subset validator — object/string/number/integer/
// boolean, required, properties, enum, minLength. Enough for the flat,
// fixed response shapes the Analyst/Investigator produce; not a general
// JSON Schema implementation, and deliberately so (no ajv dependency to
// bundle into a plain, unbundled Lambda zip).
function validateAgainstSchema(value, schema, path = '$') {
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${path}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
    }
    for (const key of schema.required || []) {
      if (!(key in value)) {
        throw new Error(`${path}: missing required property "${key}"`);
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      if (key in value) {
        validateAgainstSchema(value[key], propSchema, `${path}.${key}`);
      }
    }
    return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      throw new Error(`${path}: expected string, got ${typeof value}`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
      throw new Error(`${path}: expected one of [${schema.enum.join(', ')}], got "${value}"`);
    }
    if (schema.minLength && value.length < schema.minLength) {
      throw new Error(`${path}: string shorter than minLength ${schema.minLength}`);
    }
    return;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`${path}: expected number, got ${typeof value}`);
    }
    if (schema.type === 'integer' && !Number.isInteger(value)) {
      throw new Error(`${path}: expected integer, got ${value}`);
    }
    return;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new Error(`${path}: expected boolean, got ${typeof value}`);
    }
    return;
  }
  throw new Error(`${path}: unsupported schema type "${schema.type}"`);
}

const REQUEST_TIMEOUT_MS = 30000;

class GroqProvider {
  constructor({ apiKey, model, baseUrl = 'https://api.groq.com/openai/v1' }) {
    if (!apiKey) throw new Error('GroqProvider requires apiKey');
    if (!model) throw new Error('GroqProvider requires model');
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async _callGroq(systemPrompt, userPrompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Groq API error ${res.status}: ${text.slice(0, 500)}`);
    }

    const body = await res.json();
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Groq API response missing choices[0].message.content');
    }
    return content;
  }

  // complete(systemPrompt, userPrompt, jsonSchema) -> parsed object.
  // On JSON parse or schema validation failure, retries once with the
  // error text appended to the user prompt; on second failure, throws
  // AI_FAILED.
  async complete(systemPrompt, userPrompt, jsonSchema) {
    let prompt = userPrompt;
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await this._callGroq(systemPrompt, prompt);
        const parsed = JSON.parse(raw);
        validateAgainstSchema(parsed, jsonSchema);
        return parsed;
      } catch (err) {
        lastError = err;
        if (attempt === 2) break;
        prompt =
          `${userPrompt}\n\n---\nYour previous response was invalid: ${err.message}\n` +
          'Respond again with ONLY a single JSON object matching the required schema exactly — no prose, no markdown fences.';
      }
    }
    throw new AI_FAILED(`LLM completion failed after retry: ${lastError?.message}`, lastError);
  }
}

module.exports = { GroqProvider, AI_FAILED, validateAgainstSchema };
