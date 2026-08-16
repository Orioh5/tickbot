# Parallel Game Title Enrichment

## Goal

Reduce the first-load latency of Telegram game discovery while preserving the
full stadium title currently collected from each event page.

## Design

`GameDiscoveryService.discoverGames()` will keep its existing listing-page
navigation and extraction. Title enrichment will move from one shared page
visited serially to a bounded worker queue inside the same authenticated browser
context.

- At most two workers run concurrently.
- Each worker owns one Playwright page and processes multiple games in order
  from a shared index.
- Every worker uses the user's existing authenticated `BrowserContext`.
- Results are written back to their original game objects, so Telegram ordering
  remains identical to the listing page.
- A worker page is closed after its assignments finish.

The existing 30-second per-user result cache remains unchanged and continues to
avoid all browser work on repeated discovery calls.

## Failure Handling

Failure to load or read one event page keeps that game's listing-page name and
does not fail other games. `SESSION_EXPIRED` remains fatal: it stops enrichment
and propagates through the existing coordinator cleanup path.

Context and browser cleanup remain protected by the existing `try`/`finally`
flow. Worker pages are also closed in `finally` blocks.

## Testing

Automated tests will verify that:

- no more than two event pages are enriched concurrently;
- enrichment preserves the listing order;
- an ordinary event-page error keeps the original name;
- `SESSION_EXPIRED` still propagates;
- the complete existing test suite remains green.

## Non-goals

- Sharing discovery results between users.
- Increasing concurrency beyond two.
- Changing section discovery or monitor polling.
- Removing full-title enrichment.
