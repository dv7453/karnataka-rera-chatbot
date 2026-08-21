# karnataka-rera-chatbot

Chatbot for looking up Karnataka RERA project data from [rera.karnataka.gov.in](https://rera.karnataka.gov.in).

This is a **lookup chatbot** over scraped Karnataka RERA data. Optional **Groq** is used only to understand intent (so “hi is there any Prestige projects?” is the same search as “Search for Prestige projects”). Answers still come from SQLite, not from the model. Without `GROQ_API_KEY`, regex intent is used.

The portal has no public API, so the app uses a two-path setup:

1. **Local SQLite cache** (`rera_data.db`, included in this repo) — ~9,895 projects scraped from the portal’s project list page. The chat UI answers from that file.
2. **Live verify** — if you paste a registration number (`PRM/KA/...`), the backend checks the live portal over HTTP (no Playwright).

## Setup

The seeded database is already in the repo. You do **not** need to crawl to try the chatbot.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The header should show ~9,895 projects.

Optional — natural-language intent via Groq. Copy `.env.example` to `.env` and add your key:

```bash
GROQ_API_KEY=gsk_...
```

Then restart the server. Unrelated questions get a short “this is a RERA lookup bot” reply. Project lists are unchanged.

To refresh data from the live portal later (optional, the government page is slow):

```bash
npm run crawl -- --seed
npm run embed
```

`npm run embed` rebuilds local RAG vectors (no API key) after a crawl.

## Example queries

- Search Prestige projects
- Projects by Sobha Limited
- Projects in Bangalore
- stats
- `PRM/KA/RERA/1251/446/PR/190826/008878`

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the chat server |
| `npm run embed` | Build local RAG embeddings into SQLite (optional after crawl) |
| `npm run crawl -- --seed` | Re-fetch the portal list and update SQLite (optional) |
| `npm run crawl` | Full crawl |
| `npm run crawl:test` | Limited test crawl |

## Stack

Express, vanilla JS UI, `better-sqlite3`, `fetch` + Cheerio for scraping.
