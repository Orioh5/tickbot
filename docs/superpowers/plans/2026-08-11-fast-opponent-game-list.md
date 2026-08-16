# Fast Opponent Game List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return the Telegram game list after one listing-page navigation and label each identifiable fixture with only the opponent name.

**Architecture:** Add one pure formatter in `bot/game-discovery.js`, apply it to listing results, and remove event-page title enrichment entirely. Keep authentication, URL/order preservation, and the existing per-user cache unchanged.

**Tech Stack:** Node.js 24, CommonJS, Playwright, built-in `node:test`, `node:assert/strict`.

## Global Constraints

- Perform exactly one `context.newPage()` call during `discoverGames()`.
- Never navigate to individual event URLs during game discovery.
- Preserve each event URL and the listing order.
- Return only the opponent for confidently recognized Maccabi Haifa fixtures.
- Fall back to the original trimmed listing title for ambiguous input.
- Do not change section discovery, monitoring, or dashboard behavior.

---

### Task 1: Pure opponent-label formatter

**Files:**
- Modify: `bot/game-discovery.js`
- Test: `test/game-discovery.test.js`

**Interfaces:**
- Consumes: a listing title string.
- Produces: exported `formatOpponentName(name) -> string` for unit testing and internal use.

- [ ] **Step 1: Write failing formatter tests**

Import `formatOpponentName` from `bot/game-discovery.js` and add a table-driven test:

```js
test('formatOpponentName returns only the opponent for recognized fixtures', () => {
  const cases = [
    ['מכבי חיפה - בני סכנין', 'בני סכנין'],
    ['בני סכנין – מכבי חיפה', 'בני סכנין'],
    ['מכבי חיפה — בני סכנין 08/08/2026 20:30', 'בני סכנין'],
    ['מכבי חיפה נגד בני סכנין', 'בני סכנין'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(formatOpponentName(input), expected);
  }
});

test('formatOpponentName keeps ambiguous listing titles', () => {
  assert.equal(formatOpponentName('משחק 6154'), 'משחק 6154');
  assert.equal(formatOpponentName('גמר גביע המדינה'), 'גמר גביע המדינה');
});
```

- [ ] **Step 2: Run formatter tests and verify RED**

Run:

```bash
node --test --test-name-pattern='formatOpponentName' test/game-discovery.test.js
```

Expected: FAIL because `formatOpponentName` is not exported.

- [ ] **Step 3: Implement the minimal formatter**

Add these pure helpers before `extractGamesFromDocument`:

```js
function normalizeTeamName(value) {
  return value.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function formatOpponentName(name) {
  const original = String(name || '').trim();
  const withoutSchedule = original
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sides = withoutSchedule
    .split(/\s+(?:[-–—]|נגד)\s+/u)
    .map(side => side.trim())
    .filter(Boolean);
  if (sides.length !== 2) return original;

  const maccabi = 'מכביחיפה';
  const homeIndex = sides.findIndex(side => normalizeTeamName(side) === maccabi);
  if (homeIndex === -1 || normalizeTeamName(sides[1 - homeIndex]) === maccabi) {
    return original;
  }
  return sides[1 - homeIndex];
}
```

Export it alongside `extractGamesFromDocument`:

```js
module.exports.formatOpponentName = formatOpponentName;
```

- [ ] **Step 4: Run formatter tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern='formatOpponentName' test/game-discovery.test.js
```

Expected: both formatter tests PASS.

---

### Task 2: Single-page game discovery

**Files:**
- Modify: `bot/game-discovery.js`
- Test: `test/game-discovery.test.js`

**Interfaces:**
- Consumes: `formatOpponentName(name) -> string` from Task 1.
- Produces: `discoverGames(userId) -> Promise<Array<{name: string, url: string}>>` using one listing page.

- [ ] **Step 1: Write the failing single-page integration test**

Create a browser stub that counts pages and records navigation targets:

```js
test('discoverGames uses only the listing page and returns opponent labels', async () => {
  const listed = [
    { name: 'מכבי חיפה - בני סכנין 08/08/2026 20:30', url: 'https://tickets.mhaifafc.com/event/1' },
    { name: 'הפועל באר שבע – מכבי חיפה', url: 'https://tickets.mhaifafc.com/event/2' },
  ];
  let pageCount = 0;
  const navigations = [];
  const listingPage = makeGamePage(listed);
  const originalGoto = listingPage.goto;
  listingPage.goto = async url => {
    navigations.push(url);
    await originalGoto(url);
  };
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: async () => ({
      newContext: async () => ({
        newPage: async () => { pageCount++; return listingPage; },
        close: async () => {},
      }),
      close: async () => {},
    }),
  });

  const result = await svc.discoverGames('42');

  assert.equal(pageCount, 1);
  assert.deepEqual(navigations, ['https://tickets.mhaifafc.com/']);
  assert.deepEqual(result, [
    { name: 'בני סכנין', url: listed[0].url },
    { name: 'הפועל באר שבע', url: listed[1].url },
  ]);
});
```

- [ ] **Step 2: Run the integration test and verify RED**

Run:

```bash
node --test --test-name-pattern='uses only the listing page' test/game-discovery.test.js
```

Expected: FAIL because the current title-enrichment workers create extra pages and navigate to each event.

- [ ] **Step 3: Remove event-page enrichment and apply the formatter**

Delete `TITLE_ENRICHMENT_CONCURRENCY` and `enrichGameTitles`. In `discoverGames`, replace:

```js
const games = await page.evaluate(extractGamesFromDocument);
await enrichGameTitles(context, games);
```

with:

```js
const games = (await page.evaluate(extractGamesFromDocument)).map(game => ({
  ...game,
  name: formatOpponentName(game.name),
}));
```

- [ ] **Step 4: Remove obsolete enrichment tests and retain behavior coverage**

Delete tests and test helpers that exist only for event-page title enrichment:

- `makeControlledTitlePage`
- `waitUntil`
- `discoverGames displays the stadium title from each event page`
- concurrency, enrichment fallback, and worker cleanup tests

Keep listing authentication, listing navigation failure, cache isolation, game extraction, section discovery, and event-map tests unchanged.

- [ ] **Step 5: Run the focused suite**

Run:

```bash
node --test test/game-discovery.test.js
```

Expected: all game-discovery tests PASS.

- [ ] **Step 6: Run complete verification**

Run:

```bash
npm test
node --check bot/game-discovery.js
git diff --check
```

Expected: the complete project suite PASS, syntax check exits 0, and `git diff --check` produces no output.

- [ ] **Step 7: Stage only the relevant hunks and commit**

Because the worktree contains unrelated local changes, stage interactively:

```bash
git add -p bot/game-discovery.js test/game-discovery.test.js
git diff --cached --check
git commit -m "perf: return Telegram game list from one page"
```
