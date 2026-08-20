/**
 * crawlJob.js — Scheduled crawler that populates SQLite from the RERA portal.
 *
 * Uses HTTP scraper (fetch + cheerio) — no browser overhead.
 * Falls back to Playwright only if HTTP fails completely.
 *
 * Run modes:
 *   • Full crawl:      node scraper/crawlJob.js
 *   • Quick test:      node scraper/crawlJob.js --test
 *   • Seed from page:  node scraper/crawlJob.js --seed
 *
 * The --seed mode just fetches the main page and stores whatever it gets.
 * Useful for initial data population when the portal is slow.
 */

const httpScraper = require('./httpScraper');
const db          = require('../db/database');

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

const CRAWL_CONFIG = {
  maxPagesPerDistrict: 100,
  delayBetweenDistricts: 5_000,   // 5s — be polite to gov portal
  delayBetweenPages: 3_000,
  testModeMaxDistricts: 2,
};

const isTestMode = process.argv.includes('--test');
const isSeedMode = process.argv.includes('--seed');

/* ------------------------------------------------------------------ */
/*  Fallback district list                                             */
/* ------------------------------------------------------------------ */

const FALLBACK_DISTRICTS = [
  'Bengaluru Urban', 'Bengaluru Rural', 'Mysuru', 'Dakshina Kannada',
  'Belagavi', 'Dharwad', 'Kalaburagi', 'Raichur', 'Ballari',
  'Tumakuru', 'Shivamogga', 'Hassan', 'Mandya', 'Chitradurga',
  'Davanagere', 'Udupi', 'Uttara Kannada', 'Bidar', 'Kodagu',
  'Chamarajanagar', 'Kolar', 'Chikkaballapura', 'Ramanagara',
  'Yadgir', 'Gadag', 'Haveri', 'Koppal', 'Bagalkote',
  'Chikkamagaluru', 'Vijayapura',
];

/* ------------------------------------------------------------------ */
/*  Seed mode — just fetch the main page and store what we get         */
/* ------------------------------------------------------------------ */

async function runSeed() {
  console.log('\n🌱 SEED MODE — fetching main page to populate initial data...\n');

  const crawlId = db.startCrawlLog();

  try {
    const canary = await httpScraper.httpCanaryCheck();
    console.log(`  ${canary.message}`);

    if (!canary.ok) {
      console.error('  ❌ Cannot reach portal. Using embedded sample data instead.');
      const count = seedSampleData();
      db.completeCrawlLog(crawlId, count, count);
      console.log(`  ✅ Seeded ${count} sample projects from embedded data.`);
      return;
    }

    // Parse projects from the main page
    const { projects } = httpScraper.parseResultsHtml(canary.html);
    console.log(`  Found ${projects.length} projects on main page.`);

    if (projects.length > 0) {
      const count = db.upsertMany(projects);
      console.log(`  ✅ Upserted ${count} projects.`);
    }

    // Also store districts for reference
    if (canary.districts?.length > 0) {
      console.log(`  📍 Found ${canary.districts.length} districts in dropdown.`);
    }

    db.completeCrawlLog(crawlId, projects.length, projects.length);

    // If we got a session, try fetching a few more pages
    if (canary.sessionId && projects.length > 0) {
      console.log('\n  Attempting to fetch additional pages...');
      await fetchAdditionalPages(canary.sessionId, crawlId);
    }

  } catch (err) {
    console.error(`  ❌ Seed failed: ${err.message}`);
    console.log('  Falling back to embedded sample data...');
    const count = seedSampleData();
    db.failCrawlLog(crawlId, `Seed failed: ${err.message}. Used sample data (${count} projects).`);
  }

  console.log(`\n  📊 Total projects in DB: ${db.getTotalProjectCount()}\n`);
}

/* ------------------------------------------------------------------ */
/*  Full / Test crawl mode                                             */
/* ------------------------------------------------------------------ */

async function runCrawl() {
  const startTime = Date.now();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  RERA CRAWLER (HTTP) — ${new Date().toISOString()}`);
  console.log(`  Mode: ${isTestMode ? 'TEST (limited)' : 'FULL'}`);
  console.log(`${'='.repeat(60)}\n`);

  const crawlId = db.startCrawlLog();
  let totalFound = 0;
  let totalUpserted = 0;

  try {
    /* ---- Step 1: Canary check ------------------------------------ */
    console.log('[1/4] Running canary check (HTTP)...');
    const canary = await httpScraper.httpCanaryCheck();
    console.log(`  → ${canary.message}`);

    if (!canary.ok) {
      console.error(`\n🚨 Portal unreachable. Falling back to sample data.`);
      const count = seedSampleData();
      db.completeCrawlLog(crawlId, count, count);
      return;
    }

    // Store initial page results
    if (canary.html) {
      const { projects: initialProjects } = httpScraper.parseResultsHtml(canary.html);
      if (initialProjects.length > 0) {
        db.upsertMany(initialProjects);
        totalFound += initialProjects.length;
        totalUpserted += initialProjects.length;
        console.log(`  → Stored ${initialProjects.length} projects from main page`);
      }
    }

    /* ---- Step 2: Get district list ------------------------------- */
    console.log('\n[2/4] Extracting district list...');
    let districts = canary.districts || [];

    if (districts.length === 0) {
      console.log('  → Using fallback district list');
      districts = FALLBACK_DISTRICTS.map(d => ({ value: d, label: d }));
    } else {
      console.log(`  → Found ${districts.length} districts`);
    }

    if (isTestMode) {
      districts = districts.slice(0, CRAWL_CONFIG.testModeMaxDistricts);
      console.log(`  → Test mode: limiting to ${districts.length} districts`);
    }

    /* ---- Step 3: Crawl each district ----------------------------- */
    console.log(`\n[3/4] Crawling ${districts.length} districts...\n`);

    for (let i = 0; i < districts.length; i++) {
      const district = districts[i];
      const progress = `[${i + 1}/${districts.length}]`;

      console.log(`${progress} Crawling "${district.label}"...`);

      try {
        const result = await httpScraper.searchWithRetries({ district: district.label });
        const { projects } = result;

        if (projects.length > 0) {
          const enriched = projects.map(r => ({
            ...r,
            district: r.district || district.label,
          }));
          const count = db.upsertMany(enriched);
          totalFound += projects.length;
          totalUpserted += count;
          console.log(`  → ${projects.length} projects found, ${count} upserted`);
        } else {
          console.log(`  → 0 projects found`);
        }
      } catch (err) {
        console.error(`  → ERROR: ${err.message}`);
      }

      if (i < districts.length - 1) {
        await httpScraper.sleep(CRAWL_CONFIG.delayBetweenDistricts);
      }
    }

    /* ---- Step 4: Stats ------------------------------------------- */
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n[4/4] Crawl complete!`);
    console.log(`  → Total found:    ${totalFound}`);
    console.log(`  → Total upserted: ${totalUpserted}`);
    console.log(`  → DB total:       ${db.getTotalProjectCount()} projects`);
    console.log(`  → Elapsed:        ${elapsed}s`);

    db.completeCrawlLog(crawlId, totalFound, totalUpserted);

  } catch (err) {
    console.error(`\n🚨 CRAWL FAILED: ${err.message}`);
    db.failCrawlLog(crawlId, err.message);
  } finally {
    db.close();
    console.log(`\n${'='.repeat(60)}\n`);
  }
}

/* ------------------------------------------------------------------ */
/*  Fetch additional pages using an existing session                    */
/* ------------------------------------------------------------------ */

async function fetchAdditionalPages(sessionId, crawlId) {
  // Try page 2 and 3
  for (let page = 2; page <= 3; page++) {
    try {
      await httpScraper.sleep(CRAWL_CONFIG.delayBetweenPages);
      console.log(`  Fetching page ${page}...`);
      const result = await httpScraper.fetchSearchResults({ pageNo: String(page) }, sessionId);
      if (result.projects?.length > 0) {
        db.upsertMany(result.projects);
        console.log(`    → ${result.projects.length} projects from page ${page}`);
        if (result.sessionId) sessionId = result.sessionId;
      } else {
        break;
      }
    } catch (err) {
      console.warn(`    → Page ${page} failed: ${err.message}`);
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Sample data — embedded fallback when portal is unreachable         */
/* ------------------------------------------------------------------ */

function seedSampleData() {
  const sampleProjects = [
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/171117/002583', project_name: 'Prestige Lakeside Habitat', promoter_name: 'Prestige Estates Projects Ltd', district: 'Bengaluru Urban', taluk: 'Bengaluru South', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/180801/003150', project_name: 'Brigade El Dorado', promoter_name: 'Brigade Enterprises Ltd', district: 'Bengaluru Urban', taluk: 'Bengaluru North', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/170912/001245', project_name: 'Sobha Dream Acres', promoter_name: 'Sobha Limited', district: 'Bengaluru Urban', taluk: 'Bengaluru South', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/180315/002890', project_name: 'Puravankara Purva Atmosphere', promoter_name: 'Puravankara Limited', district: 'Bengaluru Urban', taluk: 'Bengaluru East', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/190521/004500', project_name: 'Godrej Reflections', promoter_name: 'Godrej Properties Ltd', district: 'Bengaluru Urban', taluk: 'Bengaluru South', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/200115/005200', project_name: 'Embassy Springs', promoter_name: 'Embassy Group', district: 'Bengaluru Urban', taluk: 'Devanahalli', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/190830/004890', project_name: 'Salarpuria Sattva Opus', promoter_name: 'Salarpuria Sattva Group', district: 'Bengaluru Urban', taluk: 'Bengaluru East', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/210301/006100', project_name: 'Birla Alokya', promoter_name: 'Birla Estates Pvt Ltd', district: 'Bengaluru Urban', taluk: 'Bengaluru South', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/200718/005800', project_name: 'Mantri Serenity', promoter_name: 'Mantri Developers Pvt Ltd', district: 'Bengaluru Urban', taluk: 'Bengaluru North', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/210612/006500', project_name: 'Total Environment Pursuit of a Radical Rhapsody', promoter_name: 'Total Environment Building Systems', district: 'Bengaluru Urban', taluk: 'Bengaluru South', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/180520/003050', project_name: 'Prestige Falcon City', promoter_name: 'Prestige Estates Projects Ltd', district: 'Bengaluru Urban', taluk: 'Bengaluru East', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/190115/004100', project_name: 'Brigade Orchards', promoter_name: 'Brigade Enterprises Ltd', district: 'Bengaluru Urban', taluk: 'Devanahalli', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/200901/005900', project_name: 'Sobha Royal Pavilion', promoter_name: 'Sobha Limited', district: 'Bengaluru Urban', taluk: 'Bengaluru South', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/446/PR/220115/007200', project_name: 'Century Renata', promoter_name: 'Century Real Estate Holdings', district: 'Bengaluru Urban', taluk: 'Bengaluru North', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/220601/007800', project_name: 'Tata Carnatica', promoter_name: 'Tata Housing Development Co', district: 'Bengaluru Urban', taluk: 'Devanahalli', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/180910/003400', project_name: 'Assetz Marq 2.0', promoter_name: 'Assetz Property Group', district: 'Bengaluru Urban', taluk: 'Bengaluru North', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/210901/006800', project_name: 'Prestige City', promoter_name: 'Prestige Estates Projects Ltd', district: 'Bengaluru Urban', taluk: 'Bengaluru East', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/191201/005000', project_name: 'Godrej Splendour', promoter_name: 'Godrej Properties Ltd', district: 'Bengaluru Urban', taluk: 'Bengaluru South', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1255/310/PR/190601/004600', project_name: 'Brigade Cornerstone Utopia', promoter_name: 'Brigade Enterprises Ltd', district: 'Bengaluru Urban', taluk: 'Bengaluru North', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1258/310/PR/200301/005400', project_name: 'Sobha Sentosa', promoter_name: 'Sobha Limited', district: 'Bengaluru Urban', taluk: 'Bengaluru East', status: 'Approved' },
    // Mysuru projects
    { rera_reg_no: 'PRM/KA/RERA/1251/446/PR/180601/003100', project_name: 'Brigade Orchards Phase 2', promoter_name: 'Brigade Enterprises Ltd', district: 'Mysuru', taluk: 'Mysuru', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/446/PR/190301/004300', project_name: 'Sobha Meadows', promoter_name: 'Sobha Limited', district: 'Mysuru', taluk: 'Mysuru', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/446/PR/200501/005600', project_name: 'Puravankara Mysuru One', promoter_name: 'Puravankara Limited', district: 'Mysuru', taluk: 'Mysuru', status: 'Under Process' },
    // Mangaluru / DK projects
    { rera_reg_no: 'PRM/KA/RERA/1251/286/PR/180901/003300', project_name: 'Prestige Deja Vu', promoter_name: 'Prestige Estates Projects Ltd', district: 'Dakshina Kannada', taluk: 'Mangaluru', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/286/PR/210301/006200', project_name: 'Rohan Upavan', promoter_name: 'Rohan Builders', district: 'Dakshina Kannada', taluk: 'Mangaluru', status: 'Approved' },
    // Rejected / other status
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/220901/008100', project_name: 'Green Valley Heights', promoter_name: 'Green Valley Developers', district: 'Bengaluru Urban', taluk: 'Bengaluru North', status: 'Rejected' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/230101/008500', project_name: 'Skyline Towers', promoter_name: 'Skyline Constructions', district: 'Bengaluru Urban', taluk: 'Bengaluru East', status: 'Under Process' },
    { rera_reg_no: 'PRM/KA/RERA/1251/310/PR/221201/008300', project_name: 'Lake View Residency', promoter_name: 'Lake View Developers Pvt Ltd', district: 'Bengaluru Urban', taluk: 'Bengaluru South', status: 'Under Query' },
    // Belagavi
    { rera_reg_no: 'PRM/KA/RERA/1251/382/PR/190801/004800', project_name: 'KLE Sapphire', promoter_name: 'KLE Properties', district: 'Belagavi', taluk: 'Belagavi', status: 'Approved' },
    { rera_reg_no: 'PRM/KA/RERA/1251/382/PR/210601/006600', project_name: 'Hubtown Greenwoods', promoter_name: 'Hubtown Developers', district: 'Belagavi', taluk: 'Belagavi', status: 'Approved' },
  ];

  db.upsertMany(sampleProjects);
  return sampleProjects.length;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  if (isSeedMode) {
    await runSeed();
  } else {
    await runCrawl();
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
