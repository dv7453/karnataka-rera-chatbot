/**
 * queryParser.js — NLP-lite query parser for the RERA chatbot.
 *
 * Parses natural-language user messages into structured intents:
 *
 *   Intent               When                                  Params
 *   ─────────────────────────────────────────────────────────────────────
 *   SEARCH_PROJECT        "find Prestige projects"              { projectName }
 *   SEARCH_PROMOTER       "projects by Sobha Limited"           { firmName }
 *   VERIFY_REGISTRATION   "verify PRM/KA/RERA/..."             { regNo }
 *   SEARCH_DISTRICT       "projects in Bangalore"               { district }
 *   SEARCH_STATUS         "show rejected projects"              { status }
 *   STATS                 "how many projects" / "statistics"    {}
 *   HELP                  "help" / "what can you do"            {}
 *   GREETING              "hi" / "hello"                        {}
 *   GENERAL_SEARCH        anything else with enough tokens      { query }
 */

/* ------------------------------------------------------------------ */
/*  Karnataka districts for fuzzy matching                             */
/* ------------------------------------------------------------------ */

const KARNATAKA_DISTRICTS = [
  'Bagalkote', 'Ballari', 'Belagavi', 'Bengaluru Rural', 'Bengaluru Urban',
  'Bidar', 'Chamarajanagar', 'Chikkaballapura', 'Chikkamagaluru', 'Chitradurga',
  'Dakshina Kannada', 'Davanagere', 'Dharwad', 'Gadag', 'Hassan',
  'Haveri', 'Kalaburagi', 'Kodagu', 'Kolar', 'Koppal',
  'Mandya', 'Mangaluru', 'Mysuru', 'Raichur', 'Ramanagara',
  'Shivamogga', 'Tumakuru', 'Udupi', 'Uttara Kannada', 'Vijayapura', 'Yadgir',
];

/* Common aliases people actually type */
const DISTRICT_ALIASES = {
  'bangalore':        'Bengaluru Urban',
  'bangalore urban':  'Bengaluru Urban',
  'bangalore rural':  'Bengaluru Rural',
  'bengaluru':        'Bengaluru Urban',
  'mysore':           'Mysuru',
  'mangalore':        'Mangaluru',
  'belgaum':          'Belagavi',
  'bellary':          'Ballari',
  'gulbarga':         'Kalaburagi',
  'shimoga':          'Shivamogga',
  'tumkur':           'Tumakuru',
  'hubli':            'Dharwad',
  'dharwar':          'Dharwad',
  'bijapur':          'Vijayapura',
  'chikmagalur':      'Chikkamagaluru',
  'coorg':            'Kodagu',
  'raichur':          'Raichur',
  'davangere':        'Davanagere',
};

/* ------------------------------------------------------------------ */
/*  RERA registration number patterns                                  */
/* ------------------------------------------------------------------ */

const RERA_REG_PATTERNS = [
  /PRM\/KA\/RERA\/[\w\/\-]+/i,
  /ACK\/KA\/RERA\/[\w\/\-]+/i,
  /AGRM\d{8,}/i,
  /\bKA\/RERA\/[\w\/\-]+/i,
  /\b\d{4}\/\d{3,}\/PR\/\d{6}\/\d{6}\b/,
];

/* ------------------------------------------------------------------ */
/*  Status keywords                                                    */
/* ------------------------------------------------------------------ */

const STATUS_KEYWORDS = {
  'approved':    'Approved',
  'rejected':    'Rejected',
  'withdrawn':   'Withdrawn',
  'revoked':     'Revoked',
  'pending':     'Under Process',
  'processing':  'Under Process',
  'under process': 'Under Process',
  'under query': 'Under Query',
  'query':       'Under Query',
  'completed':   'Completed',
  'completion':  'Applied for Completion',
  'registered':  'Approved',
  'lapsed':      'Lapsed',
};

/* ------------------------------------------------------------------ */
/*  Main parser                                                        */
/* ------------------------------------------------------------------ */

function parseQuery(message) {
  const raw = message.trim();
  const lower = raw.toLowerCase();

  /* ---- Greeting (only when the message is just a hello) --------- */
  const greetingOnly = /^(hi|hello|hey|greetings|good\s*(morning|afternoon|evening)|namaste)\b[\s,.!]*$/i;
  if (greetingOnly.test(lower)) {
    return { intent: 'GREETING', params: {}, raw };
  }

  /* ---- Help ------------------------------------------------------ */
  if (/^(help|what can you do|commands|how to use|how do i|guide|menu)\b/i.test(lower)) {
    return { intent: 'HELP', params: {}, raw };
  }

  /* ---- Stats ----------------------------------------------------- */
  if (/\b(stats|statistics|how many|total|count|summary|overview|dashboard)\b/i.test(lower)) {
    return { intent: 'STATS', params: {}, raw };
  }

  /* ---- Registration number (VERIFY path — live scrape) ----------- */
  for (const pattern of RERA_REG_PATTERNS) {
    const match = raw.match(pattern);
    if (match) {
      return { intent: 'VERIFY_REGISTRATION', params: { regNo: match[0] }, raw };
    }
  }

  /* ---- District search ------------------------------------------- */
  const districtMatch = matchDistrict(lower);
  if (districtMatch && /\b(project|in|from|district|area|location|near)\b/i.test(lower)) {
    return {
      intent: 'SEARCH_DISTRICT',
      params: { district: districtMatch, searchTerms: getDistrictSearchTerms(districtMatch) },
      raw,
    };
  }

  /* ---- Status search --------------------------------------------- */
  for (const [keyword, status] of Object.entries(STATUS_KEYWORDS)) {
    if (lower.includes(keyword) && /\b(show|list|find|search|get|status|projects?)\b/i.test(lower)) {
      return { intent: 'SEARCH_STATUS', params: { status }, raw };
    }
  }

  /* ---- Promoter search ------------------------------------------- */
  const promoterMatch = raw.match(/\b(?:by|promoter|builder|developer|company|firm)\s+(.+)/i);
  if (promoterMatch) {
    const firmName = stripSearchFillers(promoterMatch[1]);
    if (firmName.length >= 2) {
      return { intent: 'SEARCH_PROMOTER', params: { firmName }, raw };
    }
  }

  /* ---- Explicit project search ----------------------------------- */
  const projectMatch = raw.match(/\b(?:search|find|look\s*up|show|list|get|project)\s+(?:for\s+)?(?:project\s+)?(.+)/i);
  if (projectMatch) {
    const projectName = stripSearchFillers(projectMatch[1]);

    /* Check if the extracted term is actually a district */
    const d = matchDistrict(projectName.toLowerCase());
    if (d) {
      return {
        intent: 'SEARCH_DISTRICT',
        params: { district: d, searchTerms: getDistrictSearchTerms(d) },
        raw,
      };
    }

    if (projectName.length >= 2) {
      return { intent: 'SEARCH_PROJECT', params: { projectName }, raw };
    }
  }

  /* ---- District alone (just typed a district name) --------------- */
  if (districtMatch) {
    return {
      intent: 'SEARCH_DISTRICT',
      params: { district: districtMatch, searchTerms: getDistrictSearchTerms(districtMatch) },
      raw,
    };
  }

  /* ---- Fallback: general search ---------------------------------- */
  const cleanedQuery = stripSearchFillers(raw) || raw;
  if (cleanedQuery.length >= 2) {
    return { intent: 'GENERAL_SEARCH', params: { query: cleanedQuery }, raw };
  }

  return { intent: 'UNKNOWN', params: {}, raw };
}

/* ------------------------------------------------------------------ */
/*  District matching                                                  */
/* ------------------------------------------------------------------ */

function matchDistrict(text) {
  /* Check aliases first (most common: bangalore → Bengaluru Urban) */
  /* Longer aliases first so "bangalore rural" wins over "bangalore" */
  const aliases = Object.keys(DISTRICT_ALIASES).sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    if (text.includes(alias)) return DISTRICT_ALIASES[alias];
  }

  /* Check exact district names (case-insensitive) */
  for (const d of KARNATAKA_DISTRICTS) {
    if (text.includes(d.toLowerCase())) return d;
  }

  /* Fuzzy match — allow partial matches if similarity is high enough */
  const words = text.split(/\s+/);
  for (const word of words) {
    if (word.length < 4) continue;
    for (const d of KARNATAKA_DISTRICTS) {
      if (d.toLowerCase().startsWith(word) || word.startsWith(d.toLowerCase().slice(0, 4))) {
        return d;
      }
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Strip filler verbs/nouns from extracted search terms               */
/* ------------------------------------------------------------------ */

const LEADING_FILLERS  = /^(the|a|an|called|named|for|me|all|some|any|please|search|find|show|list|get|look\s*up|lookup|projects?|listings?)\s+/i;
const TRAILING_FILLERS = /\s+(projects?|listings?|results?|info|information|details?|rera|please)$/i;

function stripSearchFillers(text) {
  let cleaned = String(text || '').replace(/[?.!,]+$/g, '').replace(/\s+/g, ' ').trim();
  let prev;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(LEADING_FILLERS, '').trim();
  } while (cleaned && cleaned !== prev);
  do {
    prev = cleaned;
    cleaned = cleaned.replace(TRAILING_FILLERS, '').trim();
  } while (cleaned && cleaned !== prev);
  return cleaned;
}

/**
 * Expand a canonical district into search terms that also cover
 * aliases (Bangalore ↔ Bengaluru) and the city name without Urban/Rural.
 * Used as a fallback because the seed data has empty district columns.
 */
function getDistrictSearchTerms(canonical) {
  const terms = new Set();
  const add = (value) => {
    const term = String(value || '').trim();
    if (term.length >= 3) terms.add(term);
  };

  add(canonical);

  const firstWord = String(canonical || '').split(/\s+/)[0];
  if (firstWord && firstWord.length >= 4) add(firstWord);

  for (const [alias, canon] of Object.entries(DISTRICT_ALIASES)) {
    if (canon === canonical) add(alias);
  }

  return [...terms];
}

/* ------------------------------------------------------------------ */
/*  Exports                                                            */
/* ------------------------------------------------------------------ */

module.exports = {
  parseQuery,
  matchDistrict,
  stripSearchFillers,
  getDistrictSearchTerms,
  KARNATAKA_DISTRICTS,
  DISTRICT_ALIASES,
  STATUS_KEYWORDS,
};
