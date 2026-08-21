/**
 * Groq is used ONLY to understand intent.
 * Project facts still come from SQLite + hybrid retrieve — never from the model.
 */

const places = require('./places');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'qwen/qwen3.6-27b';

const SYSTEM_PROMPT = `You classify messages for a Karnataka RERA project lookup chatbot.
The bot ONLY helps with Karnataka RERA real-estate projects: project name, promoter/builder, registration number, Approved/Applied status. It does not do weather, sports, recipes, coding, news, or other topics.

Return ONLY JSON (no markdown):
{"intent":"greeting"|"help"|"stats"|"verify"|"search"|"off_topic","query":"","place":"","searchType":"project"|"promoter"|"place"|"status"|"general","regNo":"","status":""}

Rules:
- Bare hi/hello/hey/namaste with nothing else → greeting.
- Greeting PLUS a real question about projects → IGNORE the greeting and classify the question (usually search).
- "Search for Prestige projects" and "hi is there any prestige projects?" MUST both be:
  intent=search, searchType=project, query="Prestige", place=""
- Brand AND locality together MUST fill BOTH fields. Examples:
  "any hiii any prestige projects in white field" → query="Prestige", place="Whitefield", searchType=project
  "Prestige in Whitefield" → query="Prestige", place="Whitefield"
  "Sobha projects near Electronic City" → query="Sobha", place="Electronic City", searchType=promoter
- Place only (no builder/project name) → query="", place="Whitefield", searchType=place
- Extract distinctive lookup terms. Drop filler: hi, hiii, please, any, search, find, give me, locations, projects, in, the.
- Normalize "white field" / "whitefield" to place="Whitefield"
- Show approved/rejected → searchType=status, status=Approved or Applied (we only have those two).
- help / how to use / what can you do → help
- stats / how many projects in the database → stats
- A PRM/KA or ACK/KA registration number → verify, copy it into regNo
- Completely unrelated → off_topic
query: brand or project name only. place: locality only. Empty string if missing.`;

function groqEnabled() {
  return Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim());
}

function parseJsonObject(text) {
  let raw = String(text || '').trim();
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = raw.match(/\{[\s\S]*\}/);
  const jsonText = fenced ? fenced[0] : raw;
  return JSON.parse(jsonText);
}

async function classifyIntent(message) {
  if (!groqEnabled()) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY.trim()}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || DEFAULT_MODEL,
        temperature: 0,
        max_tokens: 256,
        reasoning_format: 'hidden',
        reasoning_effort: 'none',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn('[groq] HTTP', res.status, errText.slice(0, 200));
      return null;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const parsed = parseJsonObject(content);
    return normalizeClassification(parsed);
  } catch (err) {
    console.warn('[groq] classify failed:', err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeClassification(parsed) {
  const intent = String(parsed?.intent || '').toLowerCase();
  const allowed = new Set(['greeting', 'help', 'stats', 'verify', 'search', 'off_topic']);
  if (!allowed.has(intent)) return null;

  return {
    intent,
    query: String(parsed.query || '').trim(),
    place: String(parsed.place || '').trim(),
    searchType: String(parsed.searchType || 'general').toLowerCase(),
    regNo: String(parsed.regNo || '').trim(),
    status: String(parsed.status || '').trim(),
  };
}

function withPlace(params, place) {
  if (!place) return params;
  const brand = String(params.projectName || params.firmName || params.query || '').trim();
  if (!brand || brand.toLowerCase() !== place.toLowerCase()) {
    params.place = place;
  } else {
    params.place = place;
  }
  return params;
}

function toParserResult(classified, rawMessage) {
  if (!classified) return null;

  switch (classified.intent) {
    case 'greeting':
      return { intent: 'GREETING', params: {}, raw: rawMessage };
    case 'help':
      return { intent: 'HELP', params: {}, raw: rawMessage };
    case 'stats':
      return { intent: 'STATS', params: {}, raw: rawMessage };
    case 'verify':
      if (!classified.regNo) return null;
      return { intent: 'VERIFY_REGISTRATION', params: { regNo: classified.regNo }, raw: rawMessage };
    case 'off_topic':
      return { intent: 'OFF_TOPIC', params: {}, raw: rawMessage };
    case 'search': {
      const query = classified.query;
      const place = places.canonicalizePlace(classified.place) || places.inferPlace(rawMessage);
      const type = classified.searchType;

      if ((!query || query.length < 2) && !place) return null;

      if (type === 'promoter' && query) {
        return { intent: 'SEARCH_PROMOTER', params: withPlace({ firmName: query }, place), raw: rawMessage };
      }
      if (type === 'status') {
        const status = classified.status || query;
        return { intent: 'SEARCH_STATUS', params: withPlace({ status }, place), raw: rawMessage };
      }
      if (type === 'place' || (!query && place)) {
        return { intent: 'GENERAL_SEARCH', params: withPlace({ query: place, place }, place), raw: rawMessage };
      }
      return { intent: 'SEARCH_PROJECT', params: withPlace({ projectName: query }, place), raw: rawMessage };
    }
    default:
      return null;
  }
}

module.exports = {
  groqEnabled,
  classifyIntent,
  toParserResult,
};
