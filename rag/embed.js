/**
 * Precompute one embedding per project into SQLite.
 *
 *   npm run embed
 */

const db = require('../db/database');
const { buildPassage } = require('./passages');
const { MODEL_ID, DIM, embedTexts, embeddingToBuffer } = require('./model');

const BATCH_SIZE = 32;

async function main() {
  const projects = db.getAllProjects();
  console.log(`\nEmbedding ${projects.length} projects with ${MODEL_ID} (${DIM}-d)\n`);

  if (projects.length === 0) {
    console.error('No projects in rera_data.db. Seed the database first.');
    process.exit(1);
  }

  console.log('Loading model (first run downloads weights into .cache/transformers)…');
  await embedTexts(['warmup'], { isQuery: false });
  console.log('Model ready.\n');

  const started = Date.now();
  let done = 0;

  for (let i = 0; i < projects.length; i += BATCH_SIZE) {
    const batch = projects.slice(i, i + BATCH_SIZE);
    const passages = batch.map(buildPassage);
    const vectors = await embedTexts(passages, { isQuery: false });

    const rows = batch.map((project, idx) => ({
      project_id: project.id,
      doc_text: passages[idx],
      embedding: embeddingToBuffer(vectors[idx]),
      model: MODEL_ID,
      dim: DIM,
    }));

    db.replaceEmbeddings(rows);
    done += batch.length;

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const pct = ((done / projects.length) * 100).toFixed(1);
    process.stdout.write(`  ${done}/${projects.length} (${pct}%)  ${elapsed}s\r`);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const stored = db.getEmbeddingCount();
  console.log(`\n\nStored ${stored} embeddings in rera_data.db (${elapsed}s).\n`);
  db.close();
}

main().catch((err) => {
  console.error('\nEmbed failed:', err);
  db.close();
  process.exit(1);
});
