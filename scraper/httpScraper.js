/**
 * httpScraper.js — HTTP-based scraper using fetch + cheerio.
 *
 * The RERA portal embeds ALL project data as JavaScript arrays inside
 * a 6.3MB HTML page. No AJAX/API needed — we parse the inline JS.
 *
 * Data structure discovered in the HTML:
 *   applicationNameList.push('ACK/KA/RERA/...');   // Application Number
 *   applicationNameList2.push('PRM/KA/RERA/...');  // Registration Number
 *   applicationNameList3.push('Project Name');      // Project Name
 *   applicationNameList4.push('Promoter Name');     // Promoter Name
 *
 * Total: ~9,895 projects embedded in a single page load.
 */

const cheerio = require('cheerio');

const BASE_URL = 'https://rera.karnataka.gov.in';
const VIEW_ALL_URL = `${BASE_URL}/viewAllProjects`;

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

const HTTP_CONFIG = {
  timeoutMs:        300_000,      // 5 minutes — portal is slow
  liveVerifyMs:     90_000,       // chat path: live list fetch, not 5 minutes
  sessionTimeoutMs: 15_000,
  requestDelayMs:   3_000,
  maxRetries:       3,
  retryDelayMs:     10_000,
  userAgent:        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/*  Fetch the main page                                                */
/* ------------------------------------------------------------------ */

async function fetchMainPage(timeoutMs = HTTP_CONFIG.timeoutMs, sessionId = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    console.log('    [http] Fetching main page (this may take 1-5 minutes)...');
    const startTime = Date.now();

    const headers = {
      'User-Agent': HTTP_CONFIG.userAgent,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (sessionId) headers.Cookie = `JSESSIONID=${sessionId}`;

    const res = await fetch(VIEW_ALL_URL, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeout);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Get session cookie
    let jsessionid = null;
    const rawCookie = res.headers.get('set-cookie') || '';
    const cookieMatch = rawCookie.match(/JSESSIONID=([^;]+)/);
    if (cookieMatch) jsessionid = cookieMatch[1];

    const html = await res.text();
    console.log(`    [http] Got ${(html.length / 1024 / 1024).toFixed(1)}MB in ${elapsed}s`);

    return { html, jsessionid };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/*  Parse inline JavaScript to extract all project data                */
/* ------------------------------------------------------------------ */

/**
 * Extract all projects from the inline JavaScript arrays in the HTML.
 *
 * The portal embeds ~9,895 projects as JS array pushes:
 *   applicationNameList.push('ACK/...');    → app_no
 *   applicationNameList2.push('PRM/...');   → reg_no
 *   applicationNameList3.push('Name');      → project_name
 *   applicationNameList4.push('Promoter');  → promoter_name
 */
function parseProjectsFromHtml(html) {
  // Extract all values pushed to each array
  const appNos     = extractPushValues(html, 'applicationNameList');
  const regNos     = extractPushValues(html, 'applicationNameList2');
  const projNames  = extractPushValues(html, 'applicationNameList3');
  const promoters  = extractPushValues(html, 'applicationNameList4');

  // The longest array determines the count
  const count = Math.max(appNos.length, regNos.length, projNames.length, promoters.length);

  if (count === 0) {
    console.log('    [parser] Warning: No projects found in HTML');
    return [];
  }

  console.log(`    [parser] Extracted ${count} projects from inline JS`);
  console.log(`      AppNos: ${appNos.length}, RegNos: ${regNos.length}, Names: ${projNames.length}, Promoters: ${promoters.length}`);

  const projects = [];
  for (let i = 0; i < count; i++) {
    const appNo = appNos[i] || '';
    const regNo = regNos[i] || '';

    projects.push({
      rera_reg_no:   regNo || appNo,  // prefer registration number
      app_no:        appNo,
      project_name:  projNames[i] || '',
      promoter_name: promoters[i] || '',
      district:      extractDistrictFromRegNo(appNo || regNo),
      taluk:         '',
      status:        regNo ? 'Approved' : 'Applied',
      detail_url:    null,
    });
  }

  return projects;
}

/**
 * Extract all .push('value') calls for a given array name.
 * Handles both single and double quotes.
 */
function extractPushValues(html, arrayName) {
  const values = [];
  // Match: arrayName\n.push('value') or arrayName.push('value')
  // The portal uses multiline: applicationNameList\n\t\t.push('...')
  const regex = new RegExp(arrayName + "\\s*\\.push\\(['\"]([^'\"]*)['\"]\\)", 'g');
  let match;
  while ((match = regex.exec(html)) !== null) {
    values.push(match[1]);
  }
  return values;
}

/**
 * Try to extract district code from a RERA registration number.
 * Format: ACK/KA/RERA/1251/446/PR/... where 1251 might be district code.
 * This is a best-effort mapping.
 */
function extractDistrictFromRegNo(regNo) {
  // The district codes in RERA numbers are not publicly documented,
  // but we can try to identify common ones from patterns
  return '';  // Will be enriched by the search form later
}

/* ------------------------------------------------------------------ */
/*  Parse district dropdown from the page                              */
/* ------------------------------------------------------------------ */

function parseDistrictsFromHtml(html) {
  const $ = cheerio.load(html);
  const districts = [];

  // Updated selector based on actual form structure
  $('select[name="district"] option, #projectDist option').each((_, opt) => {
    const value = $(opt).attr('value');
    const label = $(opt).text().trim();
    if (value && label && value !== '0' && !label.includes('Select') && !label.includes('--')) {
      districts.push({ value, label });
    }
  });

  return districts;
}

/* ------------------------------------------------------------------ */
/*  Fetch project details via AJAX endpoint                            */
/* ------------------------------------------------------------------ */

/**
 * Get detailed project info by calling the portal's AJAX endpoint.
 * Endpoint: POST /projectDetails with data: { action: appNo }
 */
async function fetchProjectDetails(appNo, sessionId, timeoutMs = HTTP_CONFIG.timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${BASE_URL}/projectDetails`, {
      method: 'POST',
      headers: {
        'User-Agent': HTTP_CONFIG.userAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': sessionId ? `JSESSIONID=${sessionId}` : '',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': VIEW_ALL_URL,
      },
      body: `action=${encodeURIComponent(appNo)}`,
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeout);
    if (!res.ok) return {};
    const html = await res.text();
    return parseProjectDetailsHtml(html);
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * Parse the project detail HTML response.
 */
function parseProjectDetailsHtml(html) {
  const $ = cheerio.load(html);
  const details = {};

  // Extract label-value pairs from the detail HTML
  $('table tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length >= 2) {
      const label = $(tds[0]).text().trim().replace(/:$/, '');
      const value = $(tds[tds.length - 1]).text().trim();
      if (label && value && label !== value) {
        details[label] = value;
      }
    }
  });

  // Also try definition lists and form groups
  $('dl dt, .form-group label, strong, b').each((_, el) => {
    const label = $(el).text().trim().replace(/:$/, '');
    const next = $(el).next();
    if (next.length) {
      const value = next.text().trim();
      if (label && value && label !== value) {
        details[label] = value;
      }
    }
  });

  return details;
}

/* ------------------------------------------------------------------ */
/*  Live verify — POST /projectDetails (no Playwright)                 */
/* ------------------------------------------------------------------ */

/**
 * Lightweight English session. The portal often puts JSESSIONID in the
 * redirect URL rather than a Set-Cookie header.
 */
async function getLightSession() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_CONFIG.sessionTimeoutMs);

  try {
    const res = await fetch(`${BASE_URL}/changeLanguage?language=en`, {
      method: 'GET',
      headers: {
        'User-Agent': HTTP_CONFIG.userAgent,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    const rawCookie = res.headers.get('set-cookie') || '';
    const fromCookie = rawCookie.match(/JSESSIONID=([^;]+)/);
    const fromUrl = String(res.url || '').match(/jsessionid=([^?;]+)/i);
    await res.arrayBuffer().catch(() => {});
    return (fromCookie && fromCookie[1]) || (fromUrl && fromUrl[1]) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function pickDetail(details, ...needles) {
  for (const [key, value] of Object.entries(details || {})) {
    const label = key.toLowerCase().replace(/\s+/g, ' ');
    if (!needles.some((n) => label.includes(n))) continue;
    const text = String(value || '').trim();
    if (text && text !== '-' && text !== 'N/A') return text;
  }
  return '';
}

function isUsefulProjectDetails(details) {
  if (!details || typeof details !== 'object') return false;
  const keys = Object.keys(details);
  if (keys.length === 0) return false;

  const blob = `${keys.join(' ')} ${Object.values(details).join(' ')}`.toLowerCase();
  if (/\bno records?\b|\bnot found\b|\binvalid\b|\bsession expired\b/.test(blob)) return false;

  return Boolean(
    pickDetail(details, 'project name', 'name of the project', 'name of project') ||
    pickDetail(details, 'registration no', 'rera no', 'rera registration') ||
    pickDetail(details, 'promoter', 'company name', 'firm name')
  );
}

function detailsToProject(regNo, details) {
  return {
    rera_reg_no:   pickDetail(details, 'registration no', 'rera no', 'rera registration', 'application no') || regNo,
    project_name:  pickDetail(details, 'project name', 'name of the project', 'name of project'),
    promoter_name: pickDetail(details, 'promoter', 'company name', 'firm name', 'developer'),
    district:      pickDetail(details, 'district'),
    taluk:         pickDetail(details, 'taluk', 'taluka'),
    status:        pickDetail(details, 'status'),
    detail_url:    null,
    details_json:  JSON.stringify(details),
  };
}

function findProjectByRegNo(projects, regNo) {
  const needle = String(regNo || '').trim().toLowerCase();
  if (needle.length < 6) return null;

  const exact = projects.find((p) => {
    const reg = (p.rera_reg_no || '').toLowerCase();
    const app = (p.app_no || '').toLowerCase();
    return reg === needle || app === needle;
  });
  if (exact) return exact;

  return projects.find((p) => {
    const reg = (p.rera_reg_no || '').toLowerCase();
    const app = (p.app_no || '').toLowerCase();
    return (reg && (reg.includes(needle) || needle.includes(reg))) ||
           (app && (app.includes(needle) || needle.includes(app)));
  }) || null;
}

/**
 * Verify a registration / application number against the live portal.
 * Tries POST /projectDetails first, then parses the live project list.
 * Never launches Playwright.
 */
async function liveVerifyRegNo(regNo) {
  const sessionId = await getLightSession();

  try {
    const details = await fetchProjectDetails(regNo, sessionId, 8_000);
    if (isUsefulProjectDetails(details)) {
      return detailsToProject(regNo, details);
    }
  } catch {
    /* Portal often 400s this endpoint; fall through to the live list. */
  }

  const { html } = await fetchMainPage(HTTP_CONFIG.liveVerifyMs, sessionId);
  const projects = parseProjectsFromHtml(html);
  return findProjectByRegNo(projects, regNo);
}

/* ------------------------------------------------------------------ */
/*  Canary check                                                       */
/* ------------------------------------------------------------------ */

async function httpCanaryCheck() {
  try {
    const { html, jsessionid } = await fetchMainPage();

    if (!html || html.length < 1000) {
      return { ok: false, message: 'Page too short — portal may be down.', rowCount: 0 };
    }

    const projects = parseProjectsFromHtml(html);
    const districts = parseDistrictsFromHtml(html);

    return {
      ok: projects.length > 0 || html.length > 100000,
      message: `Got ${(html.length / 1024 / 1024).toFixed(1)}MB, ${projects.length} projects, ${districts.length} districts`,
      rowCount: projects.length,
      projects,
      districts,
      sessionId: jsessionid,
    };
  } catch (err) {
    return { ok: false, message: `FAILED — ${err.message}`, rowCount: 0 };
  }
}

/* ------------------------------------------------------------------ */
/*  Exports                                                            */
/* ------------------------------------------------------------------ */

module.exports = {
  fetchMainPage,
  parseProjectsFromHtml,
  parseDistrictsFromHtml,
  fetchProjectDetails,
  liveVerifyRegNo,
  getLightSession,
  httpCanaryCheck,
  HTTP_CONFIG,
  sleep,
};
