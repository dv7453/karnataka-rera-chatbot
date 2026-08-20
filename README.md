# karnataka-rera-chatbot

Chatbot for looking up Karnataka RERA project data from [rera.karnataka.gov.in](https://rera.karnataka.gov.in).

The portal has no public API, so the app uses a two-path setup:

1. **Local SQLite cache** — a crawler seeds ~9,895 projects from the portal’s project list page, then the chat UI answers from that database.
2. **Live verify** — if you paste a registration number (`PRM/KA/...`), the backend checks the live portal over HTTP (no Playwright).

## Setup

```bash
npm install
npm run crawl -- --seed
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

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
| `npm run crawl -- --seed` | Fetch the portal list and fill SQLite |
| `npm run crawl` | Full crawl |
| `npm run crawl:test` | Limited test crawl |

## Stack

Express, vanilla JS UI, `better-sqlite3`, `fetch` + Cheerio for scraping.
