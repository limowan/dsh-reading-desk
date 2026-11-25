# Changelog

## [0.1.4]

- Incremental sync: the shelf, monthly/annual reading stats and the notebook overview are still fetched every time, but per-book progress, thoughts and highlights are only re-requested when their metadata changed, missing from the cache, or older than 24 hours. Key changes reset the cache scope so data from another account cannot leak in.
- A failed sync keeps the previous successful dataset instead of replacing it.
- The sync dialog only has one action (同步数据). The temporary 全量刷新 button was removed.
- 断开并清除 now uses the in-app confirmation dialog instead of the native one.


## [0.1.3]

- Every HTTP route now checks where the call comes from: only a loopback Origin, or a Referer from this plugin's own page, is accepted; other sites in the browser are rejected (403) and direct callers with neither header get 401. `ctx.connection.requestRejection` is consulted as a fallback when available.


## [0.1.2]

- Same content as 0.1.1; that version number was consumed by npm's staged-publish bookkeeping and cannot be published.

## [0.1.1]

- Fix the plan date-range picker: hovering no longer rebuilds the popover, so the second click registers; adds month navigation.
- Search the WeRead catalogue through `/store/search` instead of filtering the local shelf; falls back to the shelf when the API is unavailable.
- Remove a book from the monthly plan (row action and batch), with an in-app confirm dialog instead of the native one.
- Batch re-date applies as soon as the range is picked; the batch bar collapses when nothing is selected.
- Notes can be pushed to flomo (incoming webhook) and Get notes (biji open API); credentials live on the host.
- WeRead API key moved to the host and only a mask reaches the page.
- AI (chat, persona one-liner, exhibition theme, note summary) now runs through `ctx.llm`; the panel shows the model and a live connectivity dot.


## [0.1.0]

- First working bundle: sidebar panel, static app hosting, WeRead gateway proxy.
- Ships the current reading-desk build as `assets/` and serves it under `/plugin/reading-desk/`.
