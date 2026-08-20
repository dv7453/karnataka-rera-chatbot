# Karnataka RERA Chatbot - Project Overview & Handoff

## 1. Project Goal
Build a chatbot that answers questions using data from the Karnataka RERA portal (rera.karnataka.gov.in). The portal has no public API, uses complex session management, and is notoriously slow. We needed a robust strategy to get this data and serve it instantly to users via a modern chat interface.

## 2. Architectural Approach
We adopted a **Two-Path Architecture** to handle the extreme latency of the government portal:
1. **Background Crawler (The Golden Dataset):** A scheduled job that crawls the RERA portal, extracts project data, and populates a local SQLite database. This ensures the chatbot is fast and doesn't rely on the portal's uptime for general queries.
2. **Fast Local Chatbot:** An Express.js server providing a sleek, dark-glassmorphism UI. It parses natural language queries and searches the local SQLite database.
3. **Live Verification Path (The Exception):** If a user provides a specific RERA registration number (e.g., `PRM/KA/...`), the chatbot bypasses the local DB and does a live HTTP scrape to verify the exact, real-time status directly against the portal.

## 3. What Was Implemented & Key Discoveries

### A. The Scraper Breakthrough (The "6.3MB HTML" Discovery)
Initially, I tried using Playwright to automate a browser, but the RERA portal is so slow that page loads constantly timed out (30s+). 
I switched to a raw HTTP approach (`fetch` + `cheerio`) and made a massive discovery: **The RERA portal does not use standard AJAX/APIs to load the main project list table.** 
Instead, it serves a single, massive 6.3MB HTML page that embeds all **~9,895 projects** directly inside inline JavaScript arrays (specifically, arrays named `applicationNameList`, `applicationNameList2`, `applicationNameList3`, etc.).
- I wrote a custom parser (`scraper/httpScraper.js`) that uses Regex to extract data directly from these inline JS array pushes.
- I created a seed script (`scraper/crawlJob.js --seed`) that successfully downloaded this 6.3MB payload, parsed all 9,895 projects (Reg No, Project Name, Promoter Name), and populated the SQLite database in one go.

### B. The Database (`db/database.js`)
- Uses `better-sqlite3` for fast, synchronous local queries.
- Schema includes a `projects` table (storing `reg_no`, `project_name`, `promoter_name`, `district`, `status`) and a `crawl_log` table to track data freshness.

### C. The Chatbot UI & Server (`public/`, `server.js`, `chatbot/queryParser.js`)
- Built a modern, dark-themed, glassmorphism UI using Vanilla JS and CSS (no heavy frameworks).
- The Express server (`server.js`) exposes `/api/chat` which takes user messages.
- Built an NLP-lite query parser (`chatbot/queryParser.js`) that uses Regex to determine user intent (e.g., `SEARCH_PROMOTER`, `STATS`, `VERIFY_REGISTRATION`, `SEARCH_PROJECT`).

## 4. Current State
- **Database is Seeded:** The database successfully contains 9,895 real projects from the RERA portal.
- **Server is Live:** The UI is fully functional and running locally.
- **Queries Work:** Basic queries like *"Projects by Sobha Limited"* or *"stats"* work perfectly and return beautiful UI cards with accurate data.

---

## 5. Remaining Bugs to Solve (Next Steps for Cursor)
During live testing, three specific edge-cases emerged that need to be resolved:

### Bug 1: Strict Parsing on "Search [Project]"
- **Issue:** Querying *"Search Prestige projects"* returns 0 results. 
- **Cause:** The `queryParser.js` regex for the `SEARCH_PROJECT` intent is a bit too loose. It accidentally extracts words like "Search" or "projects" as part of the project name. It searches the DB for the literal string *"Search Prestige projects"* instead of just *"Prestige"*.
- **Fix Required:** Refine the regex in `chatbot/queryParser.js` to strip out filler verbs/nouns before passing the extracted string to the database.

### Bug 2: Missing District Data in the Initial Seed
- **Issue:** Querying *"Projects in Bangalore"* returns 0 results.
- **Cause:** While we successfully extracted all 9,895 projects from the inline JS arrays, those specific inline arrays *do not contain district information*. Therefore, the `district` column in our SQLite DB is currently empty for all 9,895 rows.
- **Fix Required:** Modify the SQL query in `server.js` (for the `SEARCH_DISTRICT` intent). Instead of just checking the empty `district` column, it should perform a fallback `LIKE` search on the `project_name` or `promoter_name` columns (e.g., `WHERE project_name LIKE '%Bangalore%'`). Alternatively, the deeper page-by-page crawler logic needs to be run to slowly enrich the dataset with district info over time.

### Task 3: Finalize the Live-Verify Route
- **Issue:** The `VERIFY_REGISTRATION` intent currently points to older logic.
- **Cause:** Initially, we planned to use Playwright for live lookups, but we proved it times out. 
- **Fix Required:** Ensure that when a user types a specific PRM number (triggering a live lookup), the backend in `server.js` correctly uses the fast `httpScraper.js` (`fetchProjectDetails` function) to do a live POST request against the portal, rather than attempting to launch a slow Playwright browser.
