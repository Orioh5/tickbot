# Settings Panel Smooth Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the settings panel slide in and out smoothly on every open/close, eliminating the snap-open flicker.

**Architecture:** Replace the one-shot CSS `animation` (fires only on first render) with CSS `transition`s driven by a `.visible` class toggle on the overlay. The overlay stays in the DOM at all times; visibility is controlled purely by CSS. Remove `backdrop-filter: blur` to eliminate the GPU paint flash.

**Tech Stack:** Vanilla CSS transitions, vanilla JS classList API, no dependencies.

---

## Files

| File | Change |
|---|---|
| `public/style.css` | Replace `animation`/`@keyframes` with transitions; add `.visible` states; remove `backdrop-filter` |
| `public/app.js` | Replace 5 `hidden` class toggles with `visible` class toggles |
| `public/index.html` | Remove `hidden` from `#settingsOverlay` initial markup |

---

### Task 1: Update CSS — replace animation with transitions

**Files:**
- Modify: `public/style.css:540-571`

- [ ] **Step 1: Replace the `.overlay` block**

Find this block (lines 540–547):
```css
.overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
}
```

Replace with:
```css
.overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
  pointer-events: none;
}
.overlay.visible {
  pointer-events: auto;
}
```

- [ ] **Step 2: Replace the `.overlay-backdrop` block**

Find this block (lines 549–554):
```css
.overlay-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.65);
  backdrop-filter: blur(4px);
}
```

Replace with:
```css
.overlay-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.65);
  opacity: 0;
  transition: opacity 0.22s ease;
}
.overlay.visible .overlay-backdrop {
  opacity: 1;
}
```

- [ ] **Step 3: Replace the `.settings-panel` animation with a transition**

Find this block (lines 556–566):
```css
.settings-panel {
  position: relative;
  z-index: 1;
  background: var(--surface);
  border-left: 1px solid var(--border);
  width: 460px;
  max-width: 100vw;
  display: flex;
  flex-direction: column;
  animation: slide-in 0.22s cubic-bezier(0.25,0.46,0.45,0.94);
}
```

Replace with:
```css
.settings-panel {
  position: relative;
  z-index: 1;
  background: var(--surface);
  border-left: 1px solid var(--border);
  width: 460px;
  max-width: 100vw;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  opacity: 0;
  transition: transform 0.22s cubic-bezier(0.25,0.46,0.45,0.94), opacity 0.22s ease;
}
.overlay.visible .settings-panel {
  transform: translateX(0);
  opacity: 1;
}
```

- [ ] **Step 4: Delete the `@keyframes slide-in` block**

Find and delete these lines entirely (lines 568–571):
```css
@keyframes slide-in {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}
```

- [ ] **Step 5: Commit**

```bash
git add public/style.css
git commit -m "style: replace settings panel animation with CSS transitions"
```

---

### Task 2: Update HTML — remove `hidden` from overlay initial markup

**Files:**
- Modify: `public/index.html:102`

- [ ] **Step 1: Remove `hidden` from the overlay element**

Find line 102:
```html
<div id="settingsOverlay" class="overlay hidden">
```

Replace with:
```html
<div id="settingsOverlay" class="overlay">
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "html: remove hidden class from settings overlay (now controlled by .visible)"
```

---

### Task 3: Update JS — swap `hidden` toggles for `visible` toggles

**Files:**
- Modify: `public/app.js:314-343`

- [ ] **Step 1: Update the settings open handler (line 314)**

Find:
```js
ui.settingsBtn.addEventListener('click', () => ui.settingsOverlay.classList.remove('hidden'));
```

Replace with:
```js
ui.settingsBtn.addEventListener('click', () => ui.settingsOverlay.classList.add('visible'));
```

- [ ] **Step 2: Update the close button handler (line 315)**

Find:
```js
ui.closeSettingsBtn.addEventListener('click', () => ui.settingsOverlay.classList.add('hidden'));
```

Replace with:
```js
ui.closeSettingsBtn.addEventListener('click', () => ui.settingsOverlay.classList.remove('visible'));
```

- [ ] **Step 3: Update the backdrop click handler (line 316)**

Find:
```js
ui.overlayBackdrop.addEventListener('click', () => ui.settingsOverlay.classList.add('hidden'));
```

Replace with:
```js
ui.overlayBackdrop.addEventListener('click', () => ui.settingsOverlay.classList.remove('visible'));
```

- [ ] **Step 4: Update the Escape key handler (line 320)**

Find:
```js
  if (e.key === 'Escape') ui.settingsOverlay.classList.add('hidden');
```

Replace with:
```js
  if (e.key === 'Escape') ui.settingsOverlay.classList.remove('visible');
```

- [ ] **Step 5: Update the after-save handler (line 343)**

Find:
```js
    ui.settingsOverlay.classList.add('hidden');
```

Replace with:
```js
    ui.settingsOverlay.classList.remove('visible');
```

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat: settings panel now uses .visible class for smooth open/close transitions"
```

---

### Task 4: Manual verification

- [ ] **Step 1: Start the server**

```bash
npm start
```

Expected output: server listening on http://localhost:3000

- [ ] **Step 2: Open the dashboard and verify the settings panel**

Open http://localhost:3000 in a browser. Click the settings (gear) icon.

Expected: panel slides in smoothly from the right, backdrop fades in at the same time — no flicker, no snap.

- [ ] **Step 3: Close and reopen several times**

Close via the X button, then reopen. Repeat 3–4 times.

Expected: animation plays every time — not just the first open.

- [ ] **Step 4: Verify all close methods work**

- Click the X button → panel slides out
- Click the backdrop → panel slides out
- Press Escape → panel slides out
- Save settings → panel slides out

All four must close smoothly.

- [ ] **Step 5: Confirm no regression on save**

Change one setting, click Save Settings. Expected: settings are saved, panel closes with slide-out animation, "Settings saved." appears in the log.
