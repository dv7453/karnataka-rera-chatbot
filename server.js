/**
 * server.js — Express backend for the Karnataka RERA Chatbot.
 *
 * Routes:
 *   POST /api/chat       Main chatbot endpoint
 *   GET  /api/health     Health check with last crawl timestamp
 *   GET  /api/districts  List of Karnataka districts in the DB
 *
 * The chat endpoint reads from SQLite for all queries EXCEPT
 * VERIFY_REGISTRATION, which live-scrapes a single reg-no from the portal.
 */

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const db          = require('./db/database');
const parser      = require('./chatbot/queryParser');
const httpScraper = require('./scraper/httpScraper');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ */
/*  Middleware                                                         */
/* ------------------------------------------------------------------ */

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* Simple in-memory rate limiter */
const rateLimits = new Map();
function rateLimit(req, _res, next) {
  const ip = req.ip;
  const now = Date.now();
  const window = 60_000; // 1 minute
  const maxRequests = 30;

  if (!rateLimits.has(ip)) rateLimits.set(ip, []);
  const hits = rateLimits.get(ip).filter(t => t > now - window);
  hits.push(now);
  rateLimits.set(ip, hits);

  if (hits.length > maxRequests) {
    return _res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }
  next();
}

/* ------------------------------------------------------------------ */
/*  POST /api/chat                                                     */
/* ------------------------------------------------------------------ */

app.post('/api/chat', rateLimit, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.json({ reply: "Please type a message to search for RERA project information.", type: 'text' });
    }

    const { intent, params } = parser.parseQuery(message.trim());

    let reply;

    switch (intent) {
      case 'GREETING':
        reply = buildGreeting();
        break;

      case 'HELP':
        reply = buildHelp();
        break;

      case 'STATS':
        reply = buildStats();
        break;

      case 'SEARCH_PROJECT':
        reply = buildSearchResult('project_name', params.projectName, db.searchByProjectName(params.projectName));
        break;

      case 'SEARCH_PROMOTER':
        reply = buildSearchResult('promoter', params.firmName, db.searchByPromoter(params.firmName));
        break;

      case 'SEARCH_DISTRICT':
        reply = buildSearchResult(
          'district',
          params.district,
          db.searchByDistrict(params.district, 30, params.searchTerms)
        );
        break;

      case 'SEARCH_STATUS':
        reply = buildSearchResult('status', params.status, db.searchByStatus(params.status));
        break;

      case 'VERIFY_REGISTRATION':
        reply = await handleLiveVerify(params.regNo);
        break;

      case 'GENERAL_SEARCH':
        reply = buildSearchResult('query', params.query, db.generalSearch(params.query));
        break;

      default:
        reply = {
          type: 'text',
          text: "I'm not sure what you're looking for. Try searching by **project name**, **promoter**, **district**, or **RERA registration number**. Type **help** for examples.",
        };
    }

    return res.json({ reply });

  } catch (err) {
    console.error('[/api/chat] error:', err.message);
    return res.status(500).json({
      reply: {
        type: 'text',
        text: `Something went wrong while processing your request. Please try again.\n\n_Error: ${err.message}_`,
      },
    });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/health                                                    */
/* ------------------------------------------------------------------ */

app.get('/api/health', (_req, res) => {
  const lastCrawl = db.getLastSuccessfulCrawl();
  const totalProjects = db.getTotalProjectCount();

  res.json({
    status: 'ok',
    totalProjects,
    lastCrawl: lastCrawl ? {
      completedAt: lastCrawl.completed_at,
      projectsFound: lastCrawl.projects_found,
      projectsUpserted: lastCrawl.projects_upserted,
    } : null,
    dataAsOf: lastCrawl?.completed_at || 'No crawl completed yet',
  });
});

/* ------------------------------------------------------------------ */
/*  GET /api/districts                                                 */
/* ------------------------------------------------------------------ */

app.get('/api/districts', (_req, res) => {
  const districts = db.getDistinctDistricts();
  res.json({ districts });
});

/* ------------------------------------------------------------------ */
/*  Response builders                                                  */
/* ------------------------------------------------------------------ */

function buildGreeting() {
  const total = db.getTotalProjectCount();
  const lastCrawl = db.getLastSuccessfulCrawl();
  const dataInfo = lastCrawl
    ? `Data last updated: ${lastCrawl.completed_at}`
    : 'Note: Run the crawler first with `npm run crawl` to populate the database.';

  return {
    type: 'text',
    text: `👋 **Hello! I'm the Karnataka RERA Assistant.**\n\nI can help you look up real estate project information from the Karnataka RERA portal.\n\n📊 **${total.toLocaleString()}** projects in database\n📅 ${dataInfo}\n\nTry asking me things like:\n• *"Search for Prestige projects"*\n• *"Projects by Sobha Limited"*\n• *"Show projects in Bangalore"*\n• *"Verify PRM/KA/RERA/1251/..."*\n\nType **help** for all commands.`,
  };
}

function buildHelp() {
  return {
    type: 'text',
    text: `📖 **How to use the RERA Chatbot**\n\n**🔍 Search by Project Name**\n"Search Prestige Lakeside" or "find Brigade Gateway"\n\n**🏢 Search by Promoter/Builder**\n"Projects by Sobha" or "developer Prestige Group"\n\n**📍 Search by District**\n"Projects in Bangalore Urban" or "Mysore projects"\n\n**📋 Search by Status**\n"Show approved projects" or "list rejected projects"\n\n**✅ Verify Registration (Live)**\n"Verify PRM/KA/RERA/1251/310/PR/171117/002583"\n_(This checks the live RERA portal in real-time)_\n\n**📊 Statistics**\n"Stats" or "how many projects"\n\n**💡 Tips:**\n• You can use old district names (Bangalore, Mysore, Belgaum)\n• Partial names work: "Prestige" will find all Prestige projects\n• Registration number lookups go live to the portal for real-time verification`,
  };
}

function buildStats() {
  const total = db.getTotalProjectCount();
  const districts = db.getDistinctDistricts();
  const statuses = db.getStatusBreakdown();
  const lastCrawl = db.getLastSuccessfulCrawl();

  if (total === 0) {
    return {
      type: 'text',
      text: `📊 **Database is empty.**\n\nRun the crawler first to populate data:\n\`\`\`\nnpm run crawl\n\`\`\`\nOr for a quick test:\n\`\`\`\nnpm run crawl:test\n\`\`\``,
    };
  }

  let text = `📊 **RERA Database Statistics**\n\n`;
  text += `**Total Projects:** ${total.toLocaleString()}\n`;
  text += `**Last Updated:** ${lastCrawl?.completed_at || 'Unknown'}\n\n`;

  if (statuses.length > 0) {
    text += `**By Status:**\n`;
    for (const s of statuses.slice(0, 8)) {
      text += `• ${s.status || 'Unknown'}: ${s.count.toLocaleString()}\n`;
    }
  }

  if (districts.length > 0) {
    text += `\n**Top Districts:**\n`;
    for (const d of districts.slice(0, 10)) {
      text += `• ${d.district}: ${d.project_count.toLocaleString()} projects\n`;
    }
  }

  return { type: 'text', text };
}

function buildSearchResult(searchType, searchValue, results) {
  if (!results || results.length === 0) {
    const total = db.getTotalProjectCount();
    let hint = '';
    if (total === 0) {
      hint = '\n\n⚠️ The database is empty. Run `npm run crawl` to populate it first.';
    }
    return {
      type: 'text',
      text: `🔍 No projects found matching **"${searchValue}"**.${hint}\n\nTry a different search term or check for typos.`,
    };
  }

  return {
    type: 'projects',
    text: `🔍 Found **${results.length}** project${results.length > 1 ? 's' : ''} matching **"${searchValue}"**:`,
    projects: results.map(formatProject),
    searchType,
    searchValue,
  };
}

function formatProject(row) {
  return {
    rera_reg_no:   row.rera_reg_no   || '—',
    project_name:  row.project_name  || '—',
    promoter_name: row.promoter_name || '—',
    district:      row.district      || '—',
    taluk:         row.taluk         || '—',
    status:        row.status        || '—',
    updated_at:    row.updated_at    || '—',
    details:       row.details_json ? JSON.parse(row.details_json) : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Live verify — the ONLY on-demand scrape path                       */
/* ------------------------------------------------------------------ */

async function handleLiveVerify(regNo) {
  /* Step 1: Check local DB first */
  const cached = db.searchByRegNo(regNo);
  const localResult = cached.length > 0 ? cached[0] : null;

  /* Step 2: Live HTTP lookup — POST /projectDetails, never Playwright */
  let liveResult = null;
  let liveError = null;

  try {
    liveResult = await httpScraper.liveVerifyRegNo(regNo);
  } catch (err) {
    liveError = err.message;
  }

  /* Merge live fields over cache so a partial portal response doesn't wipe names */
  if (liveResult) {
    const merged = {
      ...(localResult || {}),
      ...Object.fromEntries(
        Object.entries(liveResult).filter(([, value]) => value !== null && value !== undefined && value !== '')
      ),
      rera_reg_no: liveResult.rera_reg_no || localResult?.rera_reg_no || regNo,
      details_json: liveResult.details_json || localResult?.details_json || null,
    };
    db.upsertProject(merged);

    return {
      type: 'verify',
      text: `✅ **Live Verification Complete** for \`${regNo}\``,
      project: formatProject(merged),
      source: 'live',
      verifiedAt: new Date().toISOString(),
    };
  }

  if (localResult) {
    return {
      type: 'verify',
      text: `⚠️ **Could not reach the live portal** for \`${regNo}\`.\nShowing cached data instead (from ${localResult.updated_at}):`,
      project: formatProject(localResult),
      source: 'cache',
      error: liveError,
    };
  }

  return {
    type: 'text',
    text: `❌ **Registration number not found:** \`${regNo}\`\n\nCould not find this number in the local database or the live RERA portal.${liveError ? `\n\n_Portal error: ${liveError}_` : ''}\n\nPlease double-check the registration number format (e.g., PRM/KA/RERA/1251/310/PR/171117/002583).`,
  };
}

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

app.listen(PORT, () => {
  const total = db.getTotalProjectCount();
  const lastCrawl = db.getLastSuccessfulCrawl();

  console.log(`\n🏗️  Karnataka RERA Chatbot Server`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   📊 ${total} projects in database`);
  if (lastCrawl) {
    console.log(`   📅 Last crawl: ${lastCrawl.completed_at}`);
  } else {
    console.log(`   ⚠️  No crawl data yet — run: npm run crawl`);
  }
  console.log('');
});
