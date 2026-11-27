# Reading Desk · dsh-reading-desk

English | [中文](README.zh.md)

A DeepSeek Harness (`dsh`) plugin that puts **WeRead (微信读书) reading plans, a monthly calendar, highlight review, notes and a monthly exhibition** into a sidebar panel.

![The panel](docs/preview.png)

## What it is for

WeRead tells you what you have read. It does not help you decide what to read next, and it does not bring old highlights back. This panel covers both:

| Page | What it does |
|---|---|
| Today | Which books are on for today, how many reviews are due |
| Monthly plan | Search a book → schedule it onto a date range → see progress and hours; batch re-date or remove entries |
| Monthly calendar | Which books you read each day and for how long; click a day for that day's list |
| Highlight review | Cards scheduled with **FSRS**: read the original passage, write a line back, grade it in four steps |
| Notes | Notes kept from discussions with the AI; optionally pushed to Get notes or flomo |
| Reading persona | Personality card, five-axis radar, awards of the year, nutrient table, year curve, exportable 1080×1440 image |
| Exhibition | A monthly curation poster: theme, cover strip, picks of the month (real highlights first) |
| Statistics | Five metrics, full-year heatmap, category split, book walls by month and by year |

## Install

```bash
# From npm
dsh plugin add dsh-reading-desk

# Or from GitHub
dsh plugin add github:limowan/dsh-reading-desk

# Or from a local directory
dsh plugin add /path/to/dsh-reading-desk
```

[![npm](https://img.shields.io/npm/v/dsh-reading-desk)](https://www.npmjs.com/package/dsh-reading-desk)

Sync runs in the host process, so **switching or closing the panel does not interrupt it**; the page only shows progress and writes the finished dataset.

After installing, click the **Reading Desk** icon in the sidebar. The first launch only has built-in sample data (public books and popular highlights). To see your own numbers, open **Connect WeRead** in the panel and paste a `wrk-` Agent Gateway key once.

## AI

The persona one-liner, the exhibition theme, note summaries and in-book discussion all go through the host's `ctx.llm.stream`:

- it uses the provider and model already configured in your `dsh` (`ctx.agentDefaultModel.currentSelection()`)
- **no second API key** and no separate billing path
- when the model is unavailable the panel falls back to local copy instead of breaking

## Privacy

- The WeRead key is held by the **plugin host** (file mode 0600); the page only receives a mask such as `wrk-****1234`
- Sync runs in the host process: switching panels or closing the tab does not stop it; the resulting data still lives in your machine's browser (localStorage)
- The incremental cache also lives on the host disk (`~/.dsh/storages/dsh-reading-desk/sync-cache.json`) and is cleared when the key changes
- The host only proxies reads: `/plugin/reading-desk/weread` forwards read-only calls to the WeRead gateway, limited to six read-only endpoints, a 4 KB body cap and an origin check, with no disk writes and no logging
- AI requests carry the book title, statistics and conversation text only — never the key

## Known limitations

- You sync once by hand; after that it is incremental (only changed books are refetched). Clearing browser storage means syncing again
- The bundled `assets/covers` are sample covers, copyrighted by WeRead and their publishers, used for display only
- Verified only on `dsh 0.2.2-rc.1`; earlier versions were not tested
- Panel height and light/dark theme adaptation still deserve a look on your setup

## Development

```bash
# UI: edit assets/index.html directly (single file; the prototype lives in ../预览/)
# Host: edit index.js, then disable and re-enable the plugin, or restart dsh
```

Layout:

```
index.js            host: serves assets/ + WeRead proxy + AI routes + sync job
sync-engine.mjs     host: the sync engine (port of the in-page version)
client.js           browser: sidebar icon + main panel (iframe loads the UI)
assets/             the UI (index.html / sample-data.js / covers/)
locale/{zh,en}.json plugin title and description
docs/DETAIL.md      plugin detail page
```

## License

MIT
