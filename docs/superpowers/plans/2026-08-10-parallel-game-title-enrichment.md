# Parallel Game Title Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the first Telegram game-list load time by enriching event titles with at most two concurrent Playwright pages.

**Architecture:** Keep listing extraction and the per-user cache unchanged. Replace serial reuse of the listing page with a bounded worker queue in the same authenticated browser context; each worker owns and closes one page, writes titles into the original array positions, and falls back independently on ordinary page failures.

**Tech Stack:** Node.js 24, CommonJS, Playwright, built-in `node:test`, `node:assert/strict`.

## Global Constraints

- At most two title-enrichment workers may run concurrently.
- Preserve the listing-page order exactly.
- Keep the listing name when an individual event page fails.
- Propagate `SESSION_EXPIRED` only after every worker page has settled and closed.
- Do not share discovery results between Telegram users.
- Do not change section discovery, monitoring, or dashboard behavior.

---

### Task 1: Bounded title-enrichment workers

**Files:**
- Modify: `bot/game-discovery.js`
- Modify: `test/game-discovery.test.js`

**Interfaces:**
- Consumes: Playwright-compatible `BrowserContext.newPage()` and the existing `assertAuthenticated(page)` helper.
- Produces: `enrichGameTitles(context, games) -> Promise<void>`, an internal helper that mutates only each game's `name` while preserving array order.

- [ ] **Step 1: Add deterministic concurrency helpers to the test file**

Add these helpers beside the existing Playwright stubs in `test/game-discovery.test.js`:

```js
async function waitUntil(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached');
    await new Promise(resolve => setImmediate(resolve));
  }
}

function makeControlledTitlePage({ title, onStart, fail = null, login = false, onClose }) {
  let currentUrl = 'about:blank';
  return {
    goto: async url => {
      currentUrl = url;
      await new Promise(resolve => onStart(resolve));
      if (fail) throw fail;
    },
    url: () => login ? 'https://auth.mhaifafc.com/login' : currentUrl,
    locator: selector => ({
      first: () => ({
        isVisible: async () => login && selector.includes('input[type="password"]'),
        textContent: async () => title,
      }),
    }),
    close: async () => onClose?.(),
  };
}
```

- [ ] **Step 2: Write the failing concurrency and ordering test**

Add four listing games and four controlled event pages. Start discovery, verify exactly two pages reach `goto()` before releasing either, release the first pair, then release the second pair. Assert `maxActive === 2` and the resulting names remain in listing order.

```js
test('discoverGames enriches titles with two workers and preserves listing order', async () => {
  const games = Array.from({ length: 4 }, (_, index) => ({
    name: `short-${index}`,
    url: `https://tickets.mhaifafc.com/event/${index}`,
  }));
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const eventPages = games.map((game, index) => makeControlledTitlePage({
    title: `full-${index}`,
    onStart: release => {
      active++;
      maxActive = Math.max(maxActive, active);
      releases.push(() => { active--; release(); });
    },
  }));
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeGamePage(games), ...eventPages]),
  });

  const discovery = svc.discoverGames('42');
  await waitUntil(() => releases.length === 2);
  releases.splice(0).forEach(release => release());
  await waitUntil(() => releases.length === 2);
  releases.splice(0).forEach(release => release());
  const result = await discovery;

  assert.equal(maxActive, 2);
  assert.deepEqual(result.map(game => game.name), [
    'full-0', 'full-1', 'full-2', 'full-3',
  ]);
});
```

- [ ] **Step 3: Write failing fallback and cleanup tests**

Add one test with two games where the first event page throws `new Error('navigation failed')`; release both controlled pages and assert the first listing name is retained while the second title is enriched.

Add a second test with two login-redirect pages. Count page `close()` calls, release both pages, and assert discovery rejects with `error.code === 'SESSION_EXPIRED'` only after `closedPages === 2`.

```js
assert.deepEqual(result.map(game => game.name), ['original-0', 'full-1']);
await assert.rejects(discovery, error => error.code === 'SESSION_EXPIRED');
assert.equal(closedPages, 2);
```

- [ ] **Step 4: Run the three new tests and verify RED**

Run:

```bash
node --test --test-name-pattern='two workers|keeps original|closes workers before session expiry' test/game-discovery.test.js
```

Expected: the concurrency test FAILS with `condition was not reached` because the current serial implementation never creates two controlled event pages. The test-level timeout prevents a hung test.

- [ ] **Step 5: Implement the bounded worker helper**

Add this helper in `bot/game-discovery.js` after `assertAuthenticated`:

```js
const TITLE_ENRICHMENT_CONCURRENCY = 2;

async function enrichGameTitles(context, games) {
  let nextIndex = 0;
  let fatalError = null;
  const workerCount = Math.min(TITLE_ENRICHMENT_CONCURRENCY, games.length);
  const workers = Array.from({ length: workerCount }, async () => {
    const page = await context.newPage();
    try {
      while (!fatalError && nextIndex < games.length) {
        const index = nextIndex++;
        const game = games[index];
        try {
          await page.goto(game.url, NAV_OPTS);
          await assertAuthenticated(page);
          const title = await page.locator('.stadium-title').first()
            .textContent({ timeout: 5_000 });
          if (title?.trim()) game.name = title.trim();
        } catch (error) {
          if (error?.code === 'SESSION_EXPIRED') fatalError = error;
        }
      }
    } finally {
      await page.close?.();
    }
  });

  await Promise.all(workers);
  if (fatalError) throw fatalError;
}
```

Replace the serial `for (const game of games)` block in `discoverGames()` with:

```js
await enrichGameTitles(context, games);
```

- [ ] **Step 6: Run the new tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern='two workers|keeps original|closes workers before session expiry' test/game-discovery.test.js
```

Expected: all three tests PASS; concurrency never exceeds two, ordinary failures preserve names, and both pages close before session expiry is observed by the caller.

- [ ] **Step 7: Update the existing stadium-title test for separate worker pages**

Change its browser fixture from one page that serves both listing and event navigation to two pages: `makeGamePage([{ name: 'שם מקוצר', url }])` for the listing and a second page whose `.stadium-title` returns `מכבי חיפה - הפועל באר שבע`.

Run:

```bash
node --test --test-name-pattern='displays the stadium title' test/game-discovery.test.js
```

Expected: PASS with the full stadium title.

- [ ] **Step 8: Run the focused game-discovery suite**

Run:

```bash
node --test test/game-discovery.test.js
```

Expected: all game-discovery tests PASS, including the existing per-user cache tests.

- [ ] **Step 9: Run complete verification**

Run:

```bash
npm test
node --check bot/game-discovery.js
git diff --check
```

Expected: all project tests PASS, syntax check exits 0, and `git diff --check` produces no output.

- [ ] **Step 10: Commit only the implementation files**

```bash
git add bot/game-discovery.js test/game-discovery.test.js
git commit -m "perf: parallelize Telegram game title discovery"
```
