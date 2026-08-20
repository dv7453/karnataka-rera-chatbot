/**
 * reraScraper.js — Low-level Playwright scraping module.
 *
 * This module knows how to talk to rera.karnataka.gov.in:
 *   • Fill forms, click buttons, extract tables
 *   • Get project details from a detail page
 *   • Get the list of districts from the dropdown
 *
 * It does NOT own scheduling, caching, or business logic.
 * The crawlJob.js and server.js modules orchestrate calls to this.
 *
 * Isolation: every public method creates its own BrowserContext
 * (not just a new Page in a shared context) so concurrent calls
 * never leak cookies or session state.
 */

const { chromium } = require('playwright');

const BASE_URL = 'https://rera.karnataka.gov.in';
const SEARCH_URL = `${BASE_URL}/viewAllProjects`;
const LANG_URL = `${BASE_URL}/changeLanguage?language=en`;

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

const CONFIG = {
  headless:         true,
  defaultTimeout:   60_000,       // 60s per navigation/wait (RERA portal is slow)
  requestDelayMs:   2_000,        // polite delay between portal hits
  maxRetries:       3,
  retryDelayMs:     5_000,
  userAgent:        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

/* ------------------------------------------------------------------ */
/*  Browser lifecycle                                                  */
/* ------------------------------------------------------------------ */

let _browser = null;

async function getBrowser() {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: CONFIG.headless,
      channel: 'chrome',  // use system Chrome — no Playwright Chromium download needed
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return _browser;
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

/**
 * Create an isolated BrowserContext + Page with sane defaults.
 * Caller MUST close the context when done.
 */
async function freshContext() {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: CONFIG.userAgent,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });
  context.setDefaultTimeout(CONFIG.defaultTimeout);
  const page = await context.newPage();
  return { context, page };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label = 'operation') {
  let lastErr;
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`  [retry] ${label} attempt ${attempt}/${CONFIG.maxRetries} failed: ${err.message}`);
      if (attempt < CONFIG.maxRetries) await sleep(CONFIG.retryDelayMs * attempt);
    }
  }
  throw lastErr;
}

/**
 * Ensure the page is in English.
 * Instead of a separate navigation to /changeLanguage, we set the cookie directly.
 */
async function ensureEnglish(page) {
  await page.context().addCookies([{
    name: 'lang',
    value: 'en',
    domain: 'rera.karnataka.gov.in',
    path: '/',
  }]);
}

/* ------------------------------------------------------------------ */
/*  Core: search projects on /viewAllProjects                          */
/* ------------------------------------------------------------------ */

/**
 * Search for projects using the portal's search form.
 *
 * @param {Object} params
 * @param {string} [params.projectName]
 * @param {string} [params.firmName]      Promoter / Company / Firm Name
 * @param {string} [params.regNo]         Application Number
 * @param {string} [params.regNo2]        Registration Number
 * @param {string} [params.district]      District name (value from dropdown)
 * @param {number} [params.tabIndex]      0-7, which status tab to search in (default 0 = all)
 * @param {number} [params.maxPages]      Max result pages to paginate through (default 50)
 * @returns {Promise<Array<Object>>}      Array of project summary rows
 */
async function searchProjects(params = {}) {
  const { context, page } = await freshContext();

  try {
    return await withRetry(async () => {
      /* Navigate to the search page in English */
      await ensureEnglish(page);
      await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
      await sleep(1000);

      /* Click the right status tab if requested */
      const tabIndex = params.tabIndex ?? 0;
      if (tabIndex > 0) {
        const tabs = await page.$$('.nav-link, .nav-item a, [role="tab"]');
        if (tabs[tabIndex]) {
          await tabs[tabIndex].click();
          await sleep(1000);
        }
      }

      /* Fill search fields */
      if (params.projectName) {
        await page.fill('#projectName, input[name="projectName"]', params.projectName);
      }
      if (params.firmName) {
        await page.fill('#firmName, input[name="firmName"]', params.firmName);
      }
      if (params.regNo) {
        await page.fill('#regNo, input[name="regNo"]', params.regNo);
      }
      if (params.regNo2) {
        await page.fill('#regNo2, input[name="regNo2"]', params.regNo2);
      }
      if (params.district) {
        try {
          await page.selectOption('#projectDist, select[name="projectDist"]', { label: params.district });
          await sleep(500);
        } catch {
          /* If exact label match fails, try partial */
          const options = await page.$$eval('#projectDist option, select[name="projectDist"] option', opts =>
            opts.map(o => ({ value: o.value, text: o.textContent.trim() }))
          );
          const match = options.find(o => o.text.toLowerCase().includes(params.district.toLowerCase()));
          if (match) {
            await page.selectOption('#projectDist, select[name="projectDist"]', match.value);
            await sleep(500);
          }
        }
      }

      /* Click Search */
      await page.click('button.btn-style, button:has-text("Search"), input[type="submit"][value="Search"]');

      /* Wait for results — either a table appears or a "no records" message */
      await Promise.race([
        page.waitForSelector('table tbody tr, .table tbody tr', { timeout: 15_000 }),
        page.waitForSelector('text=No Records Found', { timeout: 15_000 }),
        page.waitForSelector('text=No records', { timeout: 15_000 }),
        sleep(15_000),
      ]);
      await sleep(1000);

      /* Extract all results across pages */
      const allRows = [];
      const maxPages = params.maxPages ?? 50;
      let pageNum = 1;

      while (pageNum <= maxPages) {
        const rows = await extractTableRows(page);
        if (rows.length === 0) break;
        allRows.push(...rows);

        /* Check for next page */
        const nextBtn = await page.$('a:has-text("Next"), a:has-text("›"), .pagination .next a, a[aria-label="Next"]');
        if (!nextBtn) break;

        const isDisabled = await nextBtn.getAttribute('class').catch(() => '');
        if (isDisabled && isDisabled.includes('disabled')) break;

        await nextBtn.click();
        await sleep(CONFIG.requestDelayMs);
        pageNum++;
      }

      return allRows;
    }, 'searchProjects');
  } finally {
    await context.close();
  }
}

/**
 * Extract rows from the currently visible results table.
 */
async function extractTableRows(page) {
  const rows = [];

  try {
    /* Get headers to build column map */
    const headers = await page.$$eval(
      'table thead th, .table thead th, table tr:first-child th',
      (ths) => ths.map(th => th.textContent.trim().toLowerCase())
    );

    /* Get data rows */
    const trs = await page.$$('table tbody tr, .table tbody tr');

    for (const tr of trs) {
      const tds = await tr.$$('td');
      if (tds.length < 3) continue; // skip empty/separator rows

      const cells = [];
      for (const td of tds) {
        cells.push((await td.textContent()).trim());
      }

      /* Try to get the detail link from the row */
      let detailUrl = null;
      try {
        const link = await tr.$('a[href*="projectView"], a[href*="View"], a:has-text("View")');
        if (link) {
          detailUrl = await link.getAttribute('href');
          if (detailUrl && !detailUrl.startsWith('http')) {
            detailUrl = BASE_URL + detailUrl;
          }
        }
      } catch { /* no link */ }

      /* Also check for onclick handlers that might navigate */
      if (!detailUrl) {
        try {
          const onclick = await tr.$('button[onclick], a[onclick], td[onclick]');
          if (onclick) {
            const handler = await onclick.getAttribute('onclick');
            if (handler) {
              const urlMatch = handler.match(/['"]([^'"]*projectView[^'"]*)['"]/);
              if (urlMatch) detailUrl = BASE_URL + urlMatch[1];
            }
          }
        } catch { /* no onclick */ }
      }

      /* Map cells to object — try to use headers, fall back to positional */
      const project = mapCellsToProject(headers, cells, detailUrl);
      if (project.rera_reg_no || project.project_name) {
        rows.push(project);
      }
    }
  } catch (err) {
    console.warn(`  [extractTableRows] warning: ${err.message}`);
  }

  return rows;
}

/**
 * Map table cells to a project object.
 * Government portal tables are inconsistent, so we use both header-based
 * and positional matching.
 */
function mapCellsToProject(headers, cells, detailUrl) {
  const project = { detail_url: detailUrl };

  /* Header-based mapping */
  if (headers.length > 0 && headers.length <= cells.length) {
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      const v = cells[i];

      if (h.includes('rera') && h.includes('no') || h.includes('registration') && h.includes('no'))  project.rera_reg_no = v;
      else if (h.includes('application') && h.includes('no'))   project.rera_reg_no = project.rera_reg_no || v;
      else if (h.includes('project') && h.includes('name'))     project.project_name = v;
      else if (h.includes('promoter') || h.includes('firm') || h.includes('company')) project.promoter_name = v;
      else if (h.includes('district'))                           project.district = v;
      else if (h.includes('taluk'))                              project.taluk = v;
      else if (h.includes('status'))                             project.status = v;
    }
  }

  /* Positional fallback (typical RERA table: Sl, RegNo, ProjName, Promoter, District, Taluk, Status) */
  if (!project.rera_reg_no && cells.length >= 3) {
    project.rera_reg_no   = project.rera_reg_no   || cells[1];
    project.project_name  = project.project_name  || cells[2];
    project.promoter_name = project.promoter_name || (cells.length >= 4 ? cells[3] : null);
    project.district      = project.district      || (cells.length >= 5 ? cells[4] : null);
    project.taluk         = project.taluk         || (cells.length >= 6 ? cells[5] : null);
    project.status        = project.status        || (cells.length >= 7 ? cells[6] : null);
  }

  return project;
}

/* ------------------------------------------------------------------ */
/*  Core: get detailed project info from a detail page                 */
/* ------------------------------------------------------------------ */

/**
 * Navigate to a project detail page and extract all available fields.
 * Used for the live-verify path (single reg-no lookup).
 *
 * @param {string} url  Full URL or path to the project detail page
 * @returns {Promise<Object>}  Key/value pairs of project details
 */
async function getProjectDetails(url) {
  const { context, page } = await freshContext();

  try {
    return await withRetry(async () => {
      const fullUrl = url.startsWith('http') ? url : BASE_URL + url;

      await ensureEnglish(page);
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
      await sleep(1500);

      const details = {};

      /* Strategy 1: look for label-value pairs in definition lists, tables, or divs */
      const pairs = await page.$$eval(
        'table tr, .form-group, .row .col-md-6, .row .col-md-4, dl dt, .detail-row',
        (elements) => {
          const result = [];
          for (const el of elements) {
            /* Table rows with two cells: label + value */
            const tds = el.querySelectorAll('td');
            if (tds.length >= 2) {
              const label = tds[0].textContent.trim();
              const value = tds[tds.length - 1].textContent.trim();
              if (label && value && label !== value) result.push({ label, value });
              continue;
            }
            /* Label + span/input pairs */
            const label = el.querySelector('label, .label, strong, b, dt');
            const value = el.querySelector('span, p, .value, input, dd');
            if (label && value) {
              const l = label.textContent.trim().replace(/:$/, '');
              const v = value.textContent?.trim() || value.value?.trim() || '';
              if (l && v) result.push({ label: l, value: v });
            }
          }
          return result;
        }
      );

      for (const { label, value } of pairs) {
        if (value && value !== '-' && value !== 'N/A') {
          details[label] = value;
        }
      }

      return details;
    }, 'getProjectDetails');
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/*  Core: extract district dropdown options                            */
/* ------------------------------------------------------------------ */

async function getDistrictList() {
  const { context, page } = await freshContext();

  try {
    await ensureEnglish(page);
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
    await sleep(1000);

    const options = await page.$$eval(
      '#projectDist option, select[name="projectDist"] option',
      (opts) => opts
        .map(o => ({ value: o.value, label: o.textContent.trim() }))
        .filter(o => o.value && o.label && !o.label.includes('Select'))
    );

    return options;
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/*  Canary check — a known-good search that must return rows           */
/* ------------------------------------------------------------------ */

/**
 * Run a "canary" search — a query that should always return at least one result.
 * If it returns zero rows, the portal's HTML structure may have changed and
 * the scraper selectors are likely broken.
 *
 * @returns {Promise<{ok: boolean, message: string, rowCount: number}>}
 */
async function canaryCheck() {
  try {
    const rows = await searchProjects({ district: 'Bengaluru Urban', maxPages: 1 });
    if (rows.length > 0) {
      return { ok: true, message: `Canary passed — ${rows.length} rows returned`, rowCount: rows.length };
    }
    return { ok: false, message: 'Canary FAILED — search returned 0 rows. Selectors may be broken.', rowCount: 0 };
  } catch (err) {
    return { ok: false, message: `Canary FAILED — ${err.message}`, rowCount: 0 };
  }
}

/* ------------------------------------------------------------------ */
/*  Live verify — single registration number against the live portal   */
/* ------------------------------------------------------------------ */

/**
 * Verify a specific registration number against the live portal.
 * This is the ONLY case where we scrape on-demand during a user request.
 *
 * @param {string} regNo  Registration number to verify
 * @returns {Promise<Object|null>}  Project summary or null if not found
 */
async function liveVerifyRegNo(regNo) {
  const results = await searchProjects({ regNo2: regNo, maxPages: 1 });
  if (results.length > 0) return results[0];

  /* Also try application number field */
  const results2 = await searchProjects({ regNo: regNo, maxPages: 1 });
  return results2.length > 0 ? results2[0] : null;
}

/* ------------------------------------------------------------------ */
/*  Exports                                                            */
/* ------------------------------------------------------------------ */

module.exports = {
  searchProjects,
  getProjectDetails,
  getDistrictList,
  canaryCheck,
  liveVerifyRegNo,
  closeBrowser,
  CONFIG,
  sleep,
};
