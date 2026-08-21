/**
 * Hybrid retrieve: SQL LIKE + brute-force cosine, merged with RRF.
 */

const db = require('../db/database');
const { embedTexts, bufferToEmbedding } = require('./model');

const CHAT_CARD_MAX = 5;
const SHEET_DISPLAY_MAX = 200;
const DOWNLOAD_MAX = 1000;
const VECTOR_TOP_K = 50;
const RRF_K = 60;

let index = null;
let indexLoadAttempted = false;

function loadIndex() {
  if (index || indexLoadAttempted) return index;
  indexLoadAttempted = true;

  const rows = db.getAllEmbeddings();
  if (!rows.length) {
    index = { empty: true, n: 0 };
    return index;
  }

  const n = rows.length;
  const dim = rows[0].dim;
  const vectors = new Float32Array(n * dim);
  const ids = new Array(n);

  for (let i = 0; i < n; i++) {
    const f32 = bufferToEmbedding(rows[i].embedding);
    vectors.set(f32, i * dim);
    ids[i] = rows[i].project_id;
  }

  index = { empty: false, n, dim, vectors, ids };
  return index;
}

function invalidateIndex() {
  index = null;
  indexLoadAttempted = false;
}

function dotAt(vectors, dim, row, query) {
  let sum = 0;
  const offset = row * dim;
  for (let d = 0; d < dim; d++) {
    sum += vectors[offset + d] * query[d];
  }
  return sum;
}

async function vectorSearch(query, topK = VECTOR_TOP_K) {
  const idx = loadIndex();
  if (!idx || idx.empty || !query || String(query).trim().length < 2) return [];

  const [qv] = await embedTexts([String(query).trim()], { isQuery: true });
  const scores = new Array(idx.n);

  for (let i = 0; i < idx.n; i++) {
    scores[i] = { i, score: dotAt(idx.vectors, idx.dim, i, qv) };
  }

  scores.sort((a, b) => b.score - a.score);
  const ranked = scores.slice(0, topK);
  const ids = ranked.map((s) => idx.ids[s.i]);
  const rows = db.getProjectsByIds(ids);
  const byId = new Map(rows.map((r) => [r.id, r]));

  return ranked
    .map((s) => {
      const row = byId.get(idx.ids[s.i]);
      return row ? { ...row, _score: s.score } : null;
    })
    .filter(Boolean);
}

function vectorOnlyCutoff(vectorRows) {
  if (!vectorRows.length) return [];
  const top = vectorRows[0]._score || 0;
  const floor = Math.max(0.40, top * 0.90);
  const kept = [];
  for (const row of vectorRows) {
    if ((row._score || 0) < floor) break;
    kept.push(row);
    if (kept.length >= 5) break;
  }
  return kept;
}

function rrfMerge(listA, listB, limit, k = RRF_K) {
  const scores = new Map();
  const docs = new Map();

  function add(list) {
    (list || []).forEach((row, rank) => {
      if (!row || row.id == null) return;
      docs.set(row.id, row);
      scores.set(row.id, (scores.get(row.id) || 0) + 1 / (k + rank + 1));
    });
  }

  add(listA);
  add(listB);

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => docs.get(id))
    .filter(Boolean);
}

function likeSearch(intent, params) {
  switch (intent) {
    case 'SEARCH_PROJECT':
      return {
        rows: db.searchByProjectName(params.projectName, DOWNLOAD_MAX),
        total: db.countByProjectName(params.projectName),
        term: params.projectName,
      };
    case 'SEARCH_PROMOTER':
      return {
        rows: db.searchByPromoter(params.firmName, DOWNLOAD_MAX),
        total: db.countByPromoter(params.firmName),
        term: params.firmName,
      };
    case 'SEARCH_DISTRICT':
      return {
        rows: db.searchByDistrict(params.district, DOWNLOAD_MAX, params.searchTerms),
        total: db.countByDistrict(params.district, params.searchTerms),
        term: params.district,
      };
    case 'SEARCH_STATUS':
      return {
        rows: db.searchByStatus(params.status, DOWNLOAD_MAX),
        total: db.countByStatus(params.status),
        term: params.status,
      };
    case 'GENERAL_SEARCH':
    case 'UNKNOWN':
    default:
      return {
        rows: db.generalSearch(params.query || params.raw || '', DOWNLOAD_MAX),
        total: db.countGeneralSearch(params.query || params.raw || ''),
        term: params.query || params.raw || '',
      };
  }
}

function searchTerm(intent, params, rawMessage) {
  return (
    params.projectName
    || params.firmName
    || params.district
    || params.status
    || params.query
    || rawMessage
    || ''
  );
}

async function hybridSearch(intent, params, rawMessage) {
  const term = searchTerm(intent, params, rawMessage);
  const like = likeSearch(intent, { ...params, query: params.query || rawMessage, raw: rawMessage });

  let vectorRows = [];
  try {
    vectorRows = await vectorSearch(term, VECTOR_TOP_K);
  } catch (err) {
    console.warn('[rag] vector search skipped:', err.message);
  }

  if (like.total > 0 && like.rows.length > 0) {
    const likeIds = new Set(like.rows.map((r) => r.id));
    const overlapping = vectorRows.filter((r) => likeIds.has(r.id));
    const merged = rrfMerge(like.rows, overlapping, DOWNLOAD_MAX);
    return {
      term,
      total: like.total,
      rows: merged,
    };
  }

  const vectorHits = vectorOnlyCutoff(vectorRows);
  return {
    term,
    total: vectorHits.length,
    rows: vectorHits,
  };
}

module.exports = {
  CHAT_CARD_MAX,
  SHEET_DISPLAY_MAX,
  DOWNLOAD_MAX,
  hybridSearch,
  invalidateIndex,
  loadIndex,
};
