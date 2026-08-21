/**
 * Shared local embedding model (no API key).
 * Xenova/bge-small-en-v1.5 — 384-d, retrieval-oriented.
 */

const path = require('path');

const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const DIM = 384;
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

process.env.TRANSFORMERS_CACHE = process.env.TRANSFORMERS_CACHE
  || path.join(__dirname, '..', '.cache', 'transformers');

let extractorPromise = null;

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      return pipeline('feature-extraction', MODEL_ID);
    })();
  }
  return extractorPromise;
}

/**
 * @param {string[]} texts
 * @param {{ isQuery?: boolean }} [opts]
 * @returns {Promise<Float32Array[]>}
 */
async function embedTexts(texts, opts = {}) {
  if (!texts.length) return [];
  const extractor = await getExtractor();
  const inputs = opts.isQuery
    ? texts.map((t) => QUERY_PREFIX + String(t || '').trim())
    : texts.map((t) => String(t || '').trim());

  const output = await extractor(inputs, { pooling: 'mean', normalize: true });
  const data = output.data;
  const dims = output.dims;
  const dim = dims[dims.length - 1];
  const batch = dims.length === 1 ? 1 : dims[0];

  const vectors = [];
  for (let i = 0; i < batch; i++) {
    const slice = data.slice(i * dim, (i + 1) * dim);
    vectors.push(Float32Array.from(slice));
  }
  return vectors;
}

function embeddingToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function bufferToEmbedding(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

module.exports = {
  MODEL_ID,
  DIM,
  QUERY_PREFIX,
  getExtractor,
  embedTexts,
  embeddingToBuffer,
  bufferToEmbedding,
};
