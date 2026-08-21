/**
 * Locality matching for Karnataka / Bengaluru area names.
 * District columns in the seed DB are empty, so we AND these against name fields.
 */

const KNOWN_PLACES = [
  { needles: ['white field', 'whitefield'], canonical: 'Whitefield' },
  { needles: ['electronic city', 'electroniccity'], canonical: 'Electronic City' },
  { needles: ['sarjapur road', 'sarjapur'], canonical: 'Sarjapur' },
  { needles: ['hebbal'], canonical: 'Hebbal' },
  { needles: ['yelahanka'], canonical: 'Yelahanka' },
  { needles: ['marathahalli', 'marathalli'], canonical: 'Marathahalli' },
  { needles: ['koramangala'], canonical: 'Koramangala' },
  { needles: ['indiranagar', 'indirnagar'], canonical: 'Indiranagar' },
  { needles: ['jayanagar'], canonical: 'Jayanagar' },
  { needles: ['banashankari'], canonical: 'Banashankari' },
  { needles: ['devanahalli'], canonical: 'Devanahalli' },
];

function uniqueTerms(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const term = String(value || '').replace(/\s+/g, ' ').trim();
    if (term.length < 3) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

function canonicalizePlace(place) {
  const raw = String(place || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const compact = raw.toLowerCase().replace(/\s+/g, '');
  for (const entry of KNOWN_PLACES) {
    if (entry.needles.some((n) => n.replace(/\s+/g, '') === compact || raw.toLowerCase() === n)) {
      return entry.canonical;
    }
  }
  return raw;
}

function inferPlace(text) {
  const lower = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ')} `;
  const ranked = [...KNOWN_PLACES].sort((a, b) => (
    Math.max(...b.needles.map((n) => n.length)) - Math.max(...a.needles.map((n) => n.length))
  ));
  for (const entry of ranked) {
    if (entry.needles.some((n) => lower.includes(` ${n} `) || lower.includes(n))) {
      return entry.canonical;
    }
  }

  const inMatch = String(text || '').match(/\bin\s+(?:the\s+)?([a-z][a-z\s]{2,30}?)(?:\s+(?:area|location|locations|projects?))?[?.!]*$/i);
  if (inMatch) {
    const guessed = canonicalizePlace(inMatch[1]);
    if (guessed && !/^(the|a|an|ka|karnataka|rera)$/i.test(guessed)) return guessed;
  }
  return '';
}

function placeVariants(place) {
  const canonical = canonicalizePlace(place);
  if (!canonical) return [];
  const compact = canonical.replace(/\s+/g, '');
  const spaced = canonical.replace(/([a-z])([A-Z])/g, '$1 $2');
  const extras = [];
  for (const entry of KNOWN_PLACES) {
    if (entry.canonical.toLowerCase() === canonical.toLowerCase()) {
      extras.push(...entry.needles, entry.canonical);
    }
  }
  return uniqueTerms([canonical, compact, spaced, ...extras]);
}

module.exports = {
  canonicalizePlace,
  inferPlace,
  placeVariants,
};
