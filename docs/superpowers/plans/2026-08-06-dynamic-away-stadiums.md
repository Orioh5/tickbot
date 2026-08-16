# Dynamic Away-Stadium Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Telegram users discover, select, monitor, and automatically purchase single or combined sales areas on away-stadium maps hosted by the existing Maccabi ticket site.

**Architecture:** Add a pure `sales-area` module that owns label parsing, canonicalization, and target resolution. Game discovery will return a structured event map assembled in the browser from clickable sector controls and non-clickable SVG/map labels; Telegram and the coordinator will carry that structure into `Monitor`, which will resolve API IDs and legacy component labels to one canonical purchase area.

**Tech Stack:** Node.js 24 CommonJS, `node:test`, Playwright 1.57, SQLite (`node:sqlite`), Telegram Bot API.

## Global Constraints

- Only support events hosted on `tickets.mhaifafc.com`; do not add external ticket vendors.
- Treat a combined label such as `22,24` as one purchase target.
- Allow both available and sold-out areas discovered from the event map.
- Do not add manual area input to the Telegram flow.
- Determine availability from API data and clickability, never from a hard-coded map color.
- Send “added to cart” only after the existing reservation and cart verification succeeds.
- Preserve compatibility with existing rows that contain only URL, section strings, and quantity.
- Do not modify or commit the user's existing unrelated changes in `Dockerfile`, `server.js`, `.superpowers/`, or `railway.json`.

---

## File Structure

- Create `bot/sales-area.js`: pure parsing, normalization, merging, and target-resolution functions shared by discovery, Telegram, and monitoring.
- Modify `bot/game-discovery.js`: extract event metadata and complete/partial sales-area maps from the event page.
- Modify `bot/user-store.js`: persist optional structured event metadata in a backward-compatible JSON column.
- Modify `bot/monitor-coordinator.js`: pass structured event and area metadata into monitor settings while remaining compatible with section-only rows.
- Modify `bot/telegram-bot-service.js`: render dynamic areas and preserve canonical targets through confirmation.
- Modify `monitor.js`: map API/DOM availability to canonical combined areas and click the canonical sector once.
- Modify `test/game-discovery.test.js`, `test/telegram-bot-service.test.js`, `test/monitor-coordinator.test.js`, and `test/availability.test.js`: cover the new behavior at each boundary.
- Modify `test/user-store.test.js`: cover schema migration and structured metadata round-trips.

### Task 1: Sales-area normalization and resolution

**Files:**
- Create: `bot/sales-area.js`
- Create: `test/sales-area.test.js`

**Interfaces:**
- Produces: `normalizeAreaLabel(value: string): string`
- Produces: `areaComponents(value: string): string[]`
- Produces: `makeSalesArea({ id, label, available, source }): SalesArea`
- Produces: `mergeSalesAreas(areas: SalesArea[]): SalesArea[]`
- Produces: `resolveAreaTarget(target: string, areas: SalesArea[]): SalesArea | null`
- `SalesArea` shape: `{ id: string|null, label: string, components: string[], available: boolean, source: string }`

- [ ] **Step 1: Write failing normalization tests**

```js
test('normalizes one combined sales area without splitting its purchase identity', () => {
  assert.equal(normalizeAreaLabel(' 24 / 22 '), '22,24');
  assert.deepEqual(areaComponents('22,24'), ['22', '24']);
  assert.deepEqual(makeSalesArea({ id: 900, label: '24, 22', available: true, source: 'dom' }), {
    id: '900', label: '22,24', components: ['22', '24'], available: true, source: 'dom',
  });
});

test('resolves a component or combined legacy target to one canonical area', () => {
  const areas = [makeSalesArea({ id: 900, label: '22,24', available: false, source: 'svg' })];
  assert.equal(resolveAreaTarget('22', areas).label, '22,24');
  assert.equal(resolveAreaTarget('24', areas).label, '22,24');
  assert.equal(resolveAreaTarget('24,22', areas).label, '22,24');
});
```

- [ ] **Step 2: Run the new tests and verify the module is missing**

Run: `node --test test/sales-area.test.js`
Expected: FAIL with `Cannot find module '../bot/sales-area'`.

- [ ] **Step 3: Implement the pure sales-area module**

```js
function areaComponents(value) {
  return [...new Set(String(value || '').match(/\d+/g) || [])]
    .sort((a, b) => Number(a) - Number(b));
}

function normalizeAreaLabel(value) {
  const components = areaComponents(value);
  return components.length ? components.join(',') : String(value || '').trim();
}

function makeSalesArea({ id = null, label, available = false, source = 'manual' }) {
  const normalized = normalizeAreaLabel(label);
  return { id: id == null ? null : String(id), label: normalized,
    components: areaComponents(normalized), available: Boolean(available), source };
}
```

```js
function mergeSalesAreas(areas) {
  const merged = [];
  for (const input of areas) {
    const area = makeSalesArea(input);
    const existing = merged.find(candidate =>
      (area.id && candidate.id === area.id) || candidate.label === area.label);
    if (!existing) merged.push(area);
    else {
      existing.available ||= area.available;
      existing.id ||= area.id;
      if (existing.source !== 'dom' && area.source === 'dom') existing.source = 'dom';
    }
  }
  return merged;
}

function resolveAreaTarget(target, areas) {
  const label = normalizeAreaLabel(target);
  return areas.find(area => area.label === label) ||
    areas.find(area => areaComponents(label).some(component => area.components.includes(component))) || null;
}
```

- [ ] **Step 4: Run unit tests**

Run: `node --test test/sales-area.test.js`
Expected: PASS for normalization, merge, component resolution, unknown manual labels, and duplicate removal.

- [ ] **Step 5: Commit the isolated module**

```bash
git add bot/sales-area.js test/sales-area.test.js
git commit -m "feat: normalize dynamic stadium sales areas"
```

### Task 2: Discover complete and partial away-stadium maps

**Files:**
- Modify: `bot/game-discovery.js`
- Modify: `test/game-discovery.test.js`

**Interfaces:**
- Consumes: `makeSalesArea`, `mergeSalesAreas` from `bot/sales-area.js`
- Produces: `discoverEventMap(userId, game): Promise<EventMap>`
- `EventMap` shape: `{ eventId: string|null, gameName: string, gameUrl: string, venueName: string|null, confidence: 'complete'|'partial'|'unknown', areas: SalesArea[] }`
- Keeps: `discoverSections(userId, gameUrl)` as a compatibility wrapper returning `EventMap.areas`

- [ ] **Step 1: Add failing discovery tests for combined and sold-out areas**

```js
test('discoverEventMap preserves a combined clickable area and a sold-out map area', async () => {
  const snapshot = {
    venueName: 'Away Ground', mapLoaded: true,
    clickable: [{ id: '900', label: '22,24' }],
    mapLabels: ['22,24', '27,28'],
  };
  const svc = new GameDiscoveryService({
    userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeSectionPage(snapshot)]),
  });
  const result = await svc.discoverEventMap('42', {
    name: 'משחק חוץ', url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=7000',
  });
  assert.equal(result.confidence, 'complete');
  assert.deepEqual(result.areas.map(({ label, available }) => ({ label, available })), [
    { label: '22,24', available: true },
    { label: '27,28', available: false },
  ]);
});
```

```js
test('discoverEventMap reports partial when only clickable controls are exposed', async () => {
  const snapshot = { venueName: null, mapLoaded: true,
    clickable: [{ id: '900', label: '22,24' }], mapLabels: [] };
  const svc = new GameDiscoveryService({ userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeSectionPage(snapshot)]) });
  const result = await svc.discoverEventMap('42', { name: 'Away',
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=7000' });
  assert.equal(result.confidence, 'partial');
});

test('discoverEventMap reports unknown when no areas can be read', async () => {
  const snapshot = { venueName: null, mapLoaded: false, clickable: [], mapLabels: [] };
  const svc = new GameDiscoveryService({ userSessionStore: makeSessionStore(),
    browserFactory: makeBrowser([makeSectionPage(snapshot)]) });
  const result = await svc.discoverEventMap('42', { name: 'Away',
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=7000' });
  assert.equal(result.confidence, 'unknown');
  assert.deepEqual(result.areas, []);
});
```

- [ ] **Step 2: Run discovery tests and verify failure**

Run: `node --test test/game-discovery.test.js`
Expected: FAIL because `discoverEventMap` does not exist.

- [ ] **Step 3: Extract one browser snapshot and build EventMap**

In `page.evaluate`, return plain data only:

```js
const snapshot = await page.evaluate(() => ({
  venueName: document.querySelector('[data-venue], .venue, .stadium-name')?.textContent?.trim() || null,
  mapLoaded: Boolean(document.querySelector('svg')),
  clickable: Array.from(document.querySelectorAll('[onclick*="processSectorById"]')).map(el => ({
    id: (el.getAttribute('onclick') || '').match(/processSectorById\((\d+)\)/)?.[1] || null,
    label: el.textContent.trim(),
  })).filter(area => area.id),
  mapLabels: Array.from(document.querySelectorAll('svg text, svg [data-sector-label], [data-sector-name]'))
    .map(el => el.getAttribute('data-sector-label') || el.getAttribute('data-sector-name') || el.textContent)
    .map(text => text?.trim()).filter(text => /\d/.test(text || '')),
}));
```

Build clickable areas as available, merge map-only labels as unavailable, derive `eventId` from the URL, and classify confidence as `complete` when the loaded map yielded non-clickable labels, `partial` when only clickable areas were found, otherwise `unknown`.

- [ ] **Step 4: Preserve the compatibility wrapper**

```js
async discoverSections(userId, gameUrl) {
  const eventMap = await this.discoverEventMap(userId, { name: gameUrl, url: gameUrl });
  return eventMap.areas;
}
```

- [ ] **Step 5: Run discovery and full tests**

Run: `node --test test/game-discovery.test.js test/sales-area.test.js`
Expected: PASS, including session expiry and browser cleanup tests.

- [ ] **Step 6: Commit discovery**

```bash
git add bot/game-discovery.js test/game-discovery.test.js
git commit -m "feat: discover dynamic away stadium maps"
```

### Task 3: Telegram dynamic selection and metadata persistence

**Files:**
- Modify: `bot/user-store.js`
- Modify: `bot/monitor-coordinator.js`
- Modify: `bot/telegram-bot-service.js`
- Modify: `test/user-store.test.js`
- Modify: `test/monitor-coordinator.test.js`
- Modify: `test/telegram-bot-service.test.js`

**Interfaces:**
- Consumes: `discoverEventMap(userId, game)` and `resolveAreaTarget(target, areas)`
- Produces: coordinator method `discoverEventMap(userId, game)`
- Produces: setup payload `{ gameUrl, gameName, venueName, areas, sections, quantity }`
- Produces persisted `event_metadata` JSON: `{ gameName, venueName, areas } | null`
- Keeps: `sections: string[]` as canonical labels for monitor and legacy-row compatibility

- [ ] **Step 1: Add failing Telegram tests for dynamic buttons**

```js
test('away map shows available and sold-out combined areas as selectable buttons', async () => {
  const coordinator = {
    getStatus: () => null,
    discoverEventMap: async () => ({
      eventId: '7000', gameName: 'משחק חוץ', gameUrl: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=7000',
      venueName: 'Away Ground', confidence: 'complete',
      areas: [
        { id: '900', label: '22,24', components: ['22', '24'], available: true, source: 'dom' },
        { id: null, label: '27,28', components: ['27', '28'], available: false, source: 'svg' },
      ],
    }),
  };
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: coordinator });
  const fetch = makeFetch(Array.from({ length: 6 }, () => ({ ok: true, result: {} })));
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_game', { games: [{ name: 'משחק חוץ',
    url: 'https://tickets.mhaifafc.com/Stadium/Index?eventId=7000' }] });
  await bot._dispatch(makeCallbackUpdate(7, 'game:0'));
  const labels = fetch.calls.at(-1).body.reply_markup.inline_keyboard.flat().map(button => button.text);
  assert.ok(labels.includes('🟢 22,24'));
  assert.ok(labels.includes('⚪ 27,28'));
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test test/telegram-bot-service.test.js test/monitor-coordinator.test.js`
Expected: FAIL because the structured discovery method and dynamic-area callbacks do not exist.

- [ ] **Step 3: Add backward-compatible event metadata persistence**

Add `event_metadata TEXT` to the `CREATE TABLE` definition and inspect `PRAGMA table_info(user_monitoring)` during initialization. When absent, run:

```js
this.db.exec('ALTER TABLE user_monitoring ADD COLUMN event_metadata TEXT');
```

Extend `setMonitoringConfig` and `acceptMonitoring` with `eventMetadata = null`, storing `JSON.stringify(eventMetadata)` when present. Parse the column in `getMonitoringConfig` and `listActiveMonitoring`:

```js
eventMetadata: row.event_metadata ? JSON.parse(row.event_metadata) : null,
```

Add a test that creates a legacy database without the column, opens `UserStore`, saves `{ gameName: 'Away', venueName: 'Away Ground', areas: [...] }`, closes and reopens it, and asserts the metadata round-trips. Add a second assertion that a legacy row returns `eventMetadata: null`.

- [ ] **Step 4: Forward structured discovery through the coordinator**

```js
async discoverEventMap(userId, game) {
  return this._runDiscovery(userId, () => this.gameDiscovery.discoverEventMap(userId, game));
}
```

Keep `discoverSections` unchanged for narrow stubs and older callers.

- [ ] **Step 5: Replace Sami Ofer grouping with event areas**

Remove `STADIUM_CATALOG` from the selection path. Store `eventMap.areas` in conversation state and construct buttons with stable indexes (`area:0`, `area:1`) rather than labels, because Telegram callback data and the current `section:(\d+)` parser cannot safely represent commas.

```js
text: `${area.available ? '🟢' : '⚪'} ${selected.has(area.label) ? '✅ ' : ''}${area.label}`,
callback_data: `area:${index}`,
```

Continue requiring at least one discovered target before quantity selection. When discovery returns no areas, show a clear failure with retry and home actions.

- [ ] **Step 6: Carry event metadata through start and status**

Pass `gameName`, `venueName`, and `areas` to `startMonitor`. Persist them through `eventMetadata`. When restoring active rows, expand `row.eventMetadata || {}` into the start arguments; legacy rows keep their existing section targets.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/user-store.test.js test/telegram-bot-service.test.js test/monitor-coordinator.test.js`
Expected: PASS for home flows, combined labels, sold-out selection, unknown-map handling, session expiry, and queue lifecycle.

- [ ] **Step 8: Commit Telegram flow**

```bash
git add bot/user-store.js bot/monitor-coordinator.js bot/telegram-bot-service.js test/user-store.test.js test/monitor-coordinator.test.js test/telegram-bot-service.test.js
git commit -m "feat: select dynamic away stadium areas"
```

### Task 4: Canonical monitoring and combined-area purchase

**Files:**
- Modify: `monitor.js`
- Modify: `bot/monitor-coordinator.js`
- Modify: `test/availability.test.js`
- Modify: `test/monitor-coordinator.test.js`

**Interfaces:**
- Consumes monitor setting `areas?: SalesArea[]`
- Consumes monitor setting `sections: string[]`
- Produces internal maps `_targetToAreaLabel`, `_labelToOnclickId`, `_onclickIdToLabel`
- Keeps `_tryAutoPurchase(canonicalLabel): Promise<{ cartReady: boolean, assignments: string }>`

- [ ] **Step 1: Add failing parser and availability tests**

```js
test('preserves the full combined label from a clickable sector', () => {
  assert.deepEqual(Monitor.parseAvailableSections([
    { onclick: 'stadium.processSectorById(900)', text: '22,24' },
  ]), [{ id: '900', label: '22,24', components: ['22', '24'] }]);
});

test('a component target becomes available through its canonical combined area once', async () => {
  const monitor = new Monitor();
  monitor.settings = {
    sections: ['22'], pauseOnHit: false, autoPurchase: true,
    areas: [{ id: '900', label: '22,24', components: ['22', '24'], available: false, source: 'svg' }],
  };
  monitor.sections = { 22: { status: 'pending' } };
  monitor._tryAutoPurchase = async label => {
    assert.equal(label, '22,24');
    return { cartReady: false, assignments: 'failed' };
  };
  await monitor._applyAvailability([{ id: '900', label: '22,24', components: ['22', '24'] }]);
  assert.equal(monitor.sections['22'].status, 'available');
});
```

```js
test('two component targets trigger one canonical purchase attempt', async () => {
  const monitor = new Monitor();
  let purchases = 0;
  monitor.settings = { sections: ['22', '24'], pauseOnHit: false,
    areas: [{ id: '900', label: '22,24', components: ['22', '24'], available: false, source: 'svg' }] };
  monitor.sections = { 22: { status: 'pending' }, 24: { status: 'pending' } };
  monitor._tryAutoPurchase = async label => {
    purchases++;
    assert.equal(label, '22,24');
    return { cartReady: false, assignments: 'failed' };
  };
  monitor._notify = async () => {};
  await monitor._applyAvailability([{ id: '900', label: '22,24', components: ['22', '24'] }]);
  assert.equal(purchases, 1);
});

test('discovered metadata maps an API ID before DOM refresh', async () => {
  const monitor = new Monitor();
  monitor.settings = { sections: ['22'],
    areas: [{ id: '900', label: '22,24', components: ['22', '24'], available: false, source: 'svg' }] };
  monitor._initializeAreaMappings();
  assert.equal(monitor._onclickIdToLabel['900'], '22,24');
});
```

- [ ] **Step 2: Run availability tests and verify failure**

Run: `node --test test/availability.test.js test/monitor.test.js`
Expected: FAIL because parsing truncates `22,24` to `22` and component targets do not resolve.

- [ ] **Step 3: Initialize canonical mappings from discovered areas**

During `start(settings)`, normalize `settings.areas || []`. For each configured target, resolve it to an area and populate:

```js
this._targetToAreaLabel[target] = resolved?.label || target;
if (resolved?.id) {
  this._labelToOnclickId[resolved.label] = resolved.id;
  this._onclickIdToLabel[resolved.id] = resolved.label;
}
```

Existing section-only settings leave targets unchanged.

- [ ] **Step 4: Preserve complete labels and resolve availability canonically**

Change `parseAvailableSections` to use `normalizeAreaLabel(text)` and include `components`. In `_applyAvailability`, resolve each configured target against the union of settings areas and live areas. Group newly available configured targets by canonical label, then call `_tryAutoPurchase` and emit one alert per canonical area.

Do not change `_fetchApiAvailability`; `_pollApiAvailability` already receives internal IDs and must translate them through `_onclickIdToLabel` initialized from discovery.

- [ ] **Step 5: Make fallback notifications explicit**

When `_tryAutoPurchase` returns neither `cartReady` nor manual cart recovery, retain the existing availability notification and direct link. Ensure only the verified `cartReady` branch says tickets were added to the cart.

- [ ] **Step 6: Pass areas into monitor settings**

In `_startNow`, add `areas: Array.isArray(args.areas) ? args.areas : []`. Ensure queue entries retain `areas`, while restored legacy rows omit it safely.

- [ ] **Step 7: Run monitor tests**

Run: `node --test test/availability.test.js test/monitor.test.js test/monitor-coordinator.test.js`
Expected: PASS for combined labels, API mapping, one purchase per canonical area, standard quantity dialog, false-success prevention, and legacy settings.

- [ ] **Step 8: Commit monitoring support**

```bash
git add monitor.js bot/monitor-coordinator.js test/availability.test.js test/monitor-coordinator.test.js
git commit -m "feat: monitor and purchase combined stadium areas"
```

### Task 5: Regression verification and operator documentation

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Verifies all prior task interfaces together.
- Documents the canonical-area model for future maintenance.

- [ ] **Step 1: Update the availability documentation**

Replace the claim that only clickable list entries define all relevant sections. Document that clickable entries define current availability, map labels can define sold-out targets, and a combined label such as `22,24` is one purchase area with one internal ID.

- [ ] **Step 2: Run syntax and focused tests**

Run: `node --check bot/sales-area.js && node --check bot/game-discovery.js && node --check bot/telegram-bot-service.js && node --check bot/monitor-coordinator.js && node --check monitor.js`
Expected: all commands exit 0.

Run: `node --test test/sales-area.test.js test/game-discovery.test.js test/telegram-bot-service.test.js test/monitor-coordinator.test.js test/availability.test.js test/monitor.test.js`
Expected: all focused tests PASS.

- [ ] **Step 3: Run the complete test suite**

Run: `npm test`
Expected: all tests PASS with zero failures and no hanging Playwright/browser handles.

- [ ] **Step 4: Review the final diff**

Run: `git diff --check && git status --short`
Expected: no whitespace errors; only task files and the user's pre-existing unrelated changes appear.

- [ ] **Step 5: Commit documentation**

```bash
git add AGENTS.md
git commit -m "docs: explain dynamic stadium area detection"
```
