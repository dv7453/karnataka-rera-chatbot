const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'rera_data.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
  }
  return db;
}

/* ------------------------------------------------------------------ */
/*  Schema                                                             */
/* ------------------------------------------------------------------ */

function initTables() {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      rera_reg_no       TEXT,
      project_name      TEXT,
      promoter_name     TEXT,
      district          TEXT,
      taluk             TEXT,
      status            TEXT,
      detail_url        TEXT,
      details_json      TEXT,
      scraped_at        DATETIME DEFAULT (datetime('now')),
      updated_at        DATETIME DEFAULT (datetime('now')),
      UNIQUE(rera_reg_no)
    );

    CREATE TABLE IF NOT EXISTS crawl_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at        DATETIME,
      completed_at      DATETIME,
      status            TEXT DEFAULT 'running',
      projects_found    INTEGER DEFAULT 0,
      projects_upserted INTEGER DEFAULT 0,
      error_message     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_proj_name     ON projects(project_name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_promoter       ON projects(promoter_name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_district       ON projects(district COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_taluk          ON projects(taluk COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_status         ON projects(status COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_rera_reg       ON projects(rera_reg_no);

    CREATE TABLE IF NOT EXISTS project_embeddings (
      project_id INTEGER PRIMARY KEY,
      doc_text   TEXT NOT NULL,
      embedding  BLOB NOT NULL,
      model      TEXT NOT NULL,
      dim        INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
  `);
}

/* ------------------------------------------------------------------ */
/*  Upsert                                                             */
/* ------------------------------------------------------------------ */

function upsertProject(project) {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO projects (rera_reg_no, project_name, promoter_name, district, taluk, status, detail_url, details_json, scraped_at, updated_at)
    VALUES (@rera_reg_no, @project_name, @promoter_name, @district, @taluk, @status, @detail_url, @details_json, datetime('now'), datetime('now'))
    ON CONFLICT(rera_reg_no) DO UPDATE SET
      project_name   = excluded.project_name,
      promoter_name  = excluded.promoter_name,
      district       = excluded.district,
      taluk          = excluded.taluk,
      status         = excluded.status,
      detail_url     = excluded.detail_url,
      details_json   = COALESCE(excluded.details_json, details_json),
      updated_at     = datetime('now')
  `);
  return stmt.run({
    rera_reg_no:   project.rera_reg_no   || null,
    project_name:  project.project_name  || null,
    promoter_name: project.promoter_name || null,
    district:      project.district      || null,
    taluk:         project.taluk         || null,
    status:        project.status        || null,
    detail_url:    project.detail_url    || null,
    details_json:  project.details_json  || null,
  });
}

function upsertMany(projects) {
  const d = getDb();
  const tx = d.transaction((rows) => {
    for (const row of rows) upsertProject(row);
  });
  tx(projects);
  return projects.length;
}

/* ------------------------------------------------------------------ */
/*  Search (all queries hit local SQLite — no live scrape)             */
/* ------------------------------------------------------------------ */

function searchByProjectName(name, limit = 20) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM projects
    WHERE project_name LIKE '%' || ? || '%' COLLATE NOCASE
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(name, limit);
}

function searchByPromoter(name, limit = 20) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM projects
    WHERE promoter_name LIKE '%' || ? || '%' COLLATE NOCASE
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(name, limit);
}

function searchByDistrict(district, limit = 30, extraTerms = []) {
  const { terms, clauses, params } = districtWhere(district, extraTerms);
  if (terms.length === 0) return [];
  const d = getDb();
  return d.prepare(`
    SELECT * FROM projects
    WHERE ${clauses.join(' OR ')}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...params, limit);
}

function searchByRegNo(regNo) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM projects
    WHERE rera_reg_no LIKE '%' || ? || '%' COLLATE NOCASE
    ORDER BY updated_at DESC
    LIMIT 5
  `).all(regNo);
}

function searchByStatus(status, limit = 30) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM projects
    WHERE status LIKE '%' || ? || '%' COLLATE NOCASE
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(status, limit);
}

function generalSearch(query, limit = 20) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM projects
    WHERE project_name  LIKE '%' || ? || '%' COLLATE NOCASE
       OR promoter_name LIKE '%' || ? || '%' COLLATE NOCASE
       OR rera_reg_no   LIKE '%' || ? || '%' COLLATE NOCASE
       OR district      LIKE '%' || ? || '%' COLLATE NOCASE
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(query, query, query, query, limit);
}

function getProjectByRegNo(regNo) {
  const d = getDb();
  return d.prepare(`SELECT * FROM projects WHERE rera_reg_no = ?`).get(regNo);
}

function getAllProjects() {
  const d = getDb();
  return d.prepare(`SELECT * FROM projects ORDER BY id`).all();
}

function getProjectsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const d = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = d.prepare(`SELECT * FROM projects WHERE id IN (${placeholders})`).all(...ids);
  const map = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => map.get(id)).filter(Boolean);
}

function districtWhere(district, extraTerms = []) {
  const terms = [...new Set(
    [district, ...(Array.isArray(extraTerms) ? extraTerms : [])]
      .map((t) => String(t || '').trim())
      .filter((t) => t.length >= 3)
  )];

  const clauses = [];
  const params = [];
  for (const term of terms) {
    clauses.push(`district LIKE '%' || ? || '%' COLLATE NOCASE`);
    params.push(term);
    clauses.push(`project_name LIKE '%' || ? || '%' COLLATE NOCASE`);
    params.push(term);
    clauses.push(`promoter_name LIKE '%' || ? || '%' COLLATE NOCASE`);
    params.push(term);
  }
  return { terms, clauses, params };
}

function countByProjectName(name) {
  const d = getDb();
  return d.prepare(`
    SELECT COUNT(*) AS count FROM projects
    WHERE project_name LIKE '%' || ? || '%' COLLATE NOCASE
  `).get(name).count;
}

function countByPromoter(name) {
  const d = getDb();
  return d.prepare(`
    SELECT COUNT(*) AS count FROM projects
    WHERE promoter_name LIKE '%' || ? || '%' COLLATE NOCASE
  `).get(name).count;
}

function countByDistrict(district, extraTerms = []) {
  const { terms, clauses, params } = districtWhere(district, extraTerms);
  if (terms.length === 0) return 0;
  const d = getDb();
  return d.prepare(`SELECT COUNT(*) AS count FROM projects WHERE ${clauses.join(' OR ')}`).get(...params).count;
}

function countByStatus(status) {
  const d = getDb();
  return d.prepare(`
    SELECT COUNT(*) AS count FROM projects
    WHERE status LIKE '%' || ? || '%' COLLATE NOCASE
  `).get(status).count;
}

function countGeneralSearch(query) {
  const d = getDb();
  return d.prepare(`
    SELECT COUNT(*) AS count FROM projects
    WHERE project_name  LIKE '%' || ? || '%' COLLATE NOCASE
       OR promoter_name LIKE '%' || ? || '%' COLLATE NOCASE
       OR rera_reg_no   LIKE '%' || ? || '%' COLLATE NOCASE
       OR district      LIKE '%' || ? || '%' COLLATE NOCASE
  `).get(query, query, query, query).count;
}

/* ------------------------------------------------------------------ */
/*  Embeddings                                                         */
/* ------------------------------------------------------------------ */

function replaceEmbeddings(rows) {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO project_embeddings (project_id, doc_text, embedding, model, dim)
    VALUES (@project_id, @doc_text, @embedding, @model, @dim)
    ON CONFLICT(project_id) DO UPDATE SET
      doc_text  = excluded.doc_text,
      embedding = excluded.embedding,
      model     = excluded.model,
      dim       = excluded.dim
  `);
  const tx = d.transaction((batch) => {
    for (const row of batch) stmt.run(row);
  });
  tx(rows);
}

function getAllEmbeddings() {
  const d = getDb();
  return d.prepare(`SELECT project_id, embedding, dim, model FROM project_embeddings`).all();
}

function getEmbeddingCount() {
  const d = getDb();
  return d.prepare(`SELECT COUNT(*) AS count FROM project_embeddings`).get().count;
}

function getTotalProjectCount() {
  const d = getDb();
  const row = d.prepare(`SELECT COUNT(*) as count FROM projects`).get();
  return row.count;
}

function getDistinctDistricts() {
  const d = getDb();
  return d.prepare(`
    SELECT DISTINCT district, COUNT(*) as project_count
    FROM projects
    WHERE district IS NOT NULL AND district != ''
    GROUP BY district
    ORDER BY project_count DESC
  `).all();
}

function getStatusBreakdown() {
  const d = getDb();
  return d.prepare(`
    SELECT status, COUNT(*) as count
    FROM projects
    WHERE status IS NOT NULL AND status != ''
    GROUP BY status
    ORDER BY count DESC
  `).all();
}

/* ------------------------------------------------------------------ */
/*  Crawl log                                                          */
/* ------------------------------------------------------------------ */

function startCrawlLog() {
  const d = getDb();
  const info = d.prepare(`
    INSERT INTO crawl_log (started_at, status) VALUES (datetime('now'), 'running')
  `).run();
  return info.lastInsertRowid;
}

function completeCrawlLog(id, projectsFound, projectsUpserted) {
  const d = getDb();
  d.prepare(`
    UPDATE crawl_log
    SET completed_at = datetime('now'), status = 'completed',
        projects_found = ?, projects_upserted = ?
    WHERE id = ?
  `).run(projectsFound, projectsUpserted, id);
}

function failCrawlLog(id, errorMessage) {
  const d = getDb();
  d.prepare(`
    UPDATE crawl_log
    SET completed_at = datetime('now'), status = 'failed', error_message = ?
    WHERE id = ?
  `).run(errorMessage, id);
}

function getLastCrawlInfo() {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM crawl_log ORDER BY id DESC LIMIT 1
  `).get();
}

function getLastSuccessfulCrawl() {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM crawl_log WHERE status = 'completed' ORDER BY id DESC LIMIT 1
  `).get();
}

/* ------------------------------------------------------------------ */
/*  Cleanup                                                            */
/* ------------------------------------------------------------------ */

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb,
  upsertProject,
  upsertMany,
  searchByProjectName,
  searchByPromoter,
  searchByDistrict,
  searchByRegNo,
  searchByStatus,
  generalSearch,
  getProjectByRegNo,
  getAllProjects,
  getProjectsByIds,
  countByProjectName,
  countByPromoter,
  countByDistrict,
  countByStatus,
  countGeneralSearch,
  replaceEmbeddings,
  getAllEmbeddings,
  getEmbeddingCount,
  getTotalProjectCount,
  getDistinctDistricts,
  getStatusBreakdown,
  startCrawlLog,
  completeCrawlLog,
  failCrawlLog,
  getLastCrawlInfo,
  getLastSuccessfulCrawl,
  close,
};
