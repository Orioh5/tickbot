# Fast Opponent Game List

## Goal

Reduce Telegram game discovery latency by returning games immediately after the
listing page loads and displaying only the opponent name when it can be derived
safely.

## Design

`GameDiscoveryService.discoverGames()` will stop navigating to every event page
for `.stadium-title` enrichment. The listing page remains the sole network
navigation in game discovery.

After `extractGamesFromDocument()` returns `{ name, url }` entries, a pure
formatter will derive a concise Telegram label:

- remove date and time fragments;
- split common matchup separators such as `-`, `–`, `—`, and `נגד`;
- remove the side whose normalized name is `מכבי חיפה`;
- use the remaining non-empty side as the opponent name;
- retain the original trimmed name when the matchup cannot be identified
  confidently.

The event URL and list order remain unchanged. Home and away fixtures produce
the same opponent-only label. The existing 30-second per-user cache remains in
place and stores the shortened results.

## Failure Handling

Failure to load or authenticate the listing page keeps the existing behavior.
Ambiguous or unfamiliar titles are not guessed: the original listing title is
shown. Removing event-page enrichment also removes its per-event navigation
failures and session-expiry checks; authentication is still checked immediately
after the listing page loads.

## Testing

Automated tests will cover home and away ordering, date/time removal, Unicode
dash and Hebrew `נגד` separators, ambiguous-name fallback, preserved URLs and
ordering, and proof that discovery creates only the listing page.

The complete project test suite must remain green.

## Non-goals

- Editing Telegram messages asynchronously.
- Loading event pages to improve labels.
- Changing game selection, section discovery, monitoring, or the dashboard.
- Translating or inventing opponent names absent from the listing title.
