# Settings Panel Smooth Animation

**Date:** 2026-04-14

## Context

The settings overlay currently uses a CSS `animation` (`slide-in`) on `.settings-panel` and a `backdrop-filter: blur(4px)` on the backdrop. This causes two problems:

1. The `slide-in` animation only fires on initial page load. On the second and subsequent opens, the panel snaps into view instantly with no animation.
2. `backdrop-filter: blur(4px)` is GPU-expensive and causes a visible paint flash when the overlay appears.

The goal is to make every open/close of the settings panel feel smooth and consistent.

## Approach

Replace the one-shot CSS `animation` with CSS `transition`s driven by a `.visible` class toggle. This ensures the enter and exit transitions play on every open/close, not just the first.

Also remove `backdrop-filter: blur` in favour of a plain semi-transparent background with its own opacity transition.

## Changes

### `public/style.css`

1. **Remove** the `animation: slide-in` property from `.settings-panel` and delete the `@keyframes slide-in` block entirely.
2. **Set default (hidden) state** on `.settings-panel`:
   ```css
   transform: translateX(100%);
   opacity: 0;
   transition: transform 0.22s cubic-bezier(0.25,0.46,0.45,0.94), opacity 0.22s ease;
   ```
3. **Set visible state** triggered by `.overlay.visible`:
   ```css
   .overlay.visible .settings-panel {
     transform: translateX(0);
     opacity: 1;
   }
   ```
4. **Backdrop** — remove `backdrop-filter: blur(4px)`, keep `background: rgba(0,0,0,0.65)`, add:
   ```css
   opacity: 0;
   transition: opacity 0.22s ease;
   ```
   And:
   ```css
   .overlay.visible .overlay-backdrop {
     opacity: 1;
   }
   ```
5. **Pointer events** — `.overlay` should not intercept clicks when hidden:
   ```css
   .overlay { pointer-events: none; }
   .overlay.visible { pointer-events: auto; }
   ```
6. **Remove `.hidden` usage** from `.overlay` — the overlay stays in the DOM at all times, visibility is controlled entirely by `.visible`.

### `public/app.js`

Replace all three places that open/close the overlay:

| Before | After |
|---|---|
| `ui.settingsOverlay.classList.remove('hidden')` | `ui.settingsOverlay.classList.add('visible')` |
| `ui.settingsOverlay.classList.add('hidden')` | `ui.settingsOverlay.classList.remove('visible')` |

There are 5 occurrences total: 1 open (settings button) and 4 closes (X button, backdrop click, Escape key, after save).

### `public/index.html`

Remove the `hidden` class from the `#settingsOverlay` element's initial markup (it will now start with no `.visible` class, which keeps it invisible via CSS).

## Verification

1. Open the dashboard at `http://localhost:3000`
2. Click the Settings button — panel should slide in smoothly from the right with the backdrop fading in
3. Close via X button, backdrop click, or Escape — panel should slide back out smoothly
4. Repeat open/close several times — animation must play every time, not just the first
5. Confirm no flicker or paint flash on open
6. Confirm clicking outside the panel (on the backdrop) still closes it
7. Confirm Escape key still closes it
