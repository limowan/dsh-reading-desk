# Changelog

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
