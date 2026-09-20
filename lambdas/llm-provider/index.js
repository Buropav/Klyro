'use strict';

// Thrown when an LLM call never produces valid, schema-conforming JSON
// after exhausting every pool entry plus one schema-repair retry. Named
// (not just .name-tagged) AI_FAILED so a Step Functions Catch on
// ["AI_FAILED"] matches this error's errorType regardless of whether the
// runtime derives that from the constructor name or the .name property —
// see CLAUDE.md: "mark the run AI_FAILED — never silently switch models
// or providers mid-run." Rotating across a pre-configured pool of
// keys/models/providers on rate-limit is a distinct, explicitly-
// documented exception to that rule (see CLAUDE.md's LLM section) — it's
// picking among options the user configured up front, not improvising a
// fallback mid-run.
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

// Every provider Klyro has used (Mistral, Groq) exposes an OpenAI-
// compatible /chat/completions endpoint, so one request function covers
// all of them — a pool entry is just { apiKey, baseUrl, model }.
async function callChatCompletions({ apiKey, baseUrl, model }, systemPrompt, userPrompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
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
    const err = new Error(`LLM API error ${res.status} (${baseUrl}, model=${model}): ${text.slice(0, 500)}`);
    if (res.status === 429) {
      err.rateLimited = true;
      const retryAfterHeader = Number(res.headers.get('retry-after'));
      err.retryAfterMs = (Number.isFinite(retryAfterHeader) ? retryAfterHeader : 3) * 1000;
    }
    throw err;
  }

  const body = await res.json();
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(`LLM API response (${baseUrl}) missing choices[0].message.content`);
  }
  return content;
}

// Wraps a configured POOL of { apiKey, baseUrl, model } entries — which
// may span multiple providers, not just multiple keys for one provider —
// and rotates through them on rate limits. Each Analyst/Investigator
// invocation gets its own instance (fresh pool position each call); there
// is no cross-invocation state, by design — a "sticky" rotation position
// would just mean every Lambda cold start re-tries whichever entry
// happened to be rate-limited last time, no worse than starting at index 0.
class LLMProvider {
  constructor({ pool }) {
    if (!Array.isArray(pool) || pool.length === 0) {
      throw new Error('LLMProvider requires a non-empty pool array');
    }
    for (const entry of pool) {
      if (!entry.apiKey || !entry.baseUrl || !entry.model) {
        throw new Error('LLMProvider pool entries need apiKey, baseUrl, and model');
      }
    }
    this.pool = pool;
    this.poolIndex = 0;
  }

  current() {
    return this.pool[this.poolIndex];
  }

  rotate() {
    this.poolIndex = (this.poolIndex + 1) % this.pool.length;
  }

  // complete(systemPrompt, userPrompt, jsonSchema) -> parsed object.
  //
  // Two independent retry budgets, spent in whichever order the errors
  // actually occur:
  //  - Rate limits (429): rotate to the next pool entry (a different
  //    key, possibly a different provider/model entirely) and retry the
  //    SAME prompt immediately — no backoff needed, since a different
  //    entry has its own independent limit. Cycles through every entry
  //    at most once before falling back to a single backoff-and-retry on
  //    whichever entry it ended on, in case the whole pool is genuinely
  //    exhausted rather than mid-burst.
  //  - Schema/parse failures: retry once (same pool entry) with the
  //    error text appended to the prompt, per CLAUDE.md's "retry the
  //    same call once with the error appended... then mark the run
  //    AI_FAILED."
  // Exhausting both throws AI_FAILED.
  async complete(systemPrompt, userPrompt, jsonSchema) {
    let prompt = userPrompt;
    let lastError;
    let entriesTried = 0;
    let usedSchemaRetry = false;

    while (true) {
      try {
        const raw = await callChatCompletions(this.current(), systemPrompt, prompt);
        const parsed = JSON.parse(raw);
        validateAgainstSchema(parsed, jsonSchema);
        return parsed;
      } catch (err) {
        lastError = err;

        if (err.rateLimited) {
          entriesTried += 1;
          if (entriesTried < this.pool.length) {
            this.rotate();
            continue; // fresh entry, same prompt, no backoff needed
          }
          if (entriesTried === this.pool.length) {
            // Every entry has now been tried at least once. One last
            // backoff-and-retry on the current entry in case it was
            // transient, then give up.
            await new Promise((resolve) => setTimeout(resolve, Math.min(err.retryAfterMs, 10000)));
            entriesTried += 1; // ensures this branch can't loop forever
            continue;
          }
          break;
        }

        if (!usedSchemaRetry) {
          usedSchemaRetry = true;
          prompt =
            `${userPrompt}\n\n---\nYour previous response was invalid: ${err.message}\n` +
            'Respond again with ONLY a single JSON object matching the required schema exactly — no prose, no markdown fences.';
          continue;
        }

        break;
      }
    }
    throw new AI_FAILED(
      `LLM completion failed after trying ${this.pool.length} pool entr${this.pool.length === 1 ? 'y' : 'ies'}: ${lastError?.message}`,
      lastError
    );
  }
}

module.exports = { LLMProvider, AI_FAILED, validateAgainstSchema };
