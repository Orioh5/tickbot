# Dynamic Away-Stadium Support

## Goal

Support away matches sold on the existing Maccabi Haifa ticket site when their stadium map differs from Sami Ofer. Users must be able to monitor currently available areas and sold-out areas, enter an area manually when discovery is incomplete, and use the existing automatic add-to-cart flow when tickets appear.

## Scope

This design covers events hosted on `tickets.mhaifafc.com`. It does not add support for external ticket vendors. Away-match maps are assumed to use the same general-admission purchase flow: selecting a clickable sales area opens the usual ticket-quantity dialog.

An area may represent one block or several blocks together. For example, a single clickable area labelled `22,24` is one purchase target and must not be treated as two independent targets.

## Event and Stadium Discovery

Game discovery will return structured event metadata rather than only a name and URL:

- Event name and URL.
- Event ID.
- Venue name when the page exposes one.
- Discovered sales areas.
- Current availability for each area.
- Discovery confidence: `complete`, `partial`, or `unknown`.

Each sales area will contain:

- The ticket site's internal sector ID.
- Its full display label, such as `22,24`.
- Normalized component block labels, such as `["22", "24"]`.
- Whether it is currently available/clickable.
- The source used to discover or map it.

Discovery will combine the live clickable-sector elements, SVG/map labels, page data, and the sectors API where available. Clickable elements alone are insufficient because sold-out areas can be absent from that collection.

The existing Sami Ofer catalog may remain as optional display metadata, but it will no longer determine which choices Telegram users can select. The event page is the source of truth.

## Selection Workflow

Telegram will show one button per sales area. A combined area appears as one button, for example `22,24`.

Users can also enter areas manually. Input is normalized so that `22`, `24`, or `22,24` can resolve to the combined `22,24` sales area when that mapping is known. If the mapping is unknown, the manual value is retained as an explicit monitoring target rather than silently discarded.

Both available and sold-out discovered areas are selectable. Availability is shown as state, not used to filter the list. If discovery is partial, the bot explains that the list may be incomplete and offers manual entry.

Persisted monitoring configuration will retain the event name, venue metadata, canonical sales-area targets, component labels, URL, and desired quantity. Status and alert messages will use the human-readable event and area labels.

## Availability Monitoring

The monitor will primarily poll the sectors API for efficiency. It will use the discovery mapping to translate internal sector IDs into canonical sales-area labels.

The map and DOM will be refreshed when:

- A newly available internal ID is not mapped.
- A monitored area becomes available and must be clicked.
- API polling fails or returns an untrustworthy result.

Availability will be determined from clickability and API data, not from a hard-coded color such as red. Map colors are presentation details and may vary between stadiums or events.

A manual component target matches a canonical combined area when the mapping says the component belongs to it. The monitor reports and purchases the canonical area once, preventing duplicate alerts or purchase attempts for `22` and `24`.

## Add to Cart

Away matches use the same general-admission strategy as the existing flow:

1. Resolve the selected canonical area to its current internal sector ID.
2. Refresh the event page if the clickable element is stale or missing.
3. Click the complete sales area, including combined areas such as `22,24`.
4. Wait for the normal quantity dialog.
5. Enter the desired quantity and submit the reservation.
6. Verify the reservation response, cart navigation, and cart contents.
7. Send an “added to cart” message only after verification succeeds.

If mapping, clicking, or cart verification fails, the bot sends an availability alert and direct event link. It must not claim that tickets were added to the cart.

## Error Handling

- Missing venue metadata does not block monitoring.
- Partial discovery enables manual selection and is surfaced to the user.
- An unrecognized map structure produces a safe manual-entry workflow rather than an empty dead end.
- Session expiry keeps the existing reconnect behavior.
- Queue-it detection remains informational and does not attempt to bypass the queue.
- A canonical area that cannot currently be clicked remains monitored and can become actionable on a later refresh.

## Compatibility and Migration

Existing monitoring rows contain a URL, section strings, and quantity. They remain valid and are interpreted as manual targets when richer area metadata is absent. No destructive database migration is required.

The legacy dashboard continues to accept manual section input. Dynamic event metadata is primarily required for the Telegram workflow and shared monitor logic; dashboard UI changes are limited to displaying canonical labels correctly.

## Testing

Automated tests will cover:

- Discovery of a single-block area.
- Discovery and preservation of a combined `22,24` area.
- Inclusion of sold-out/non-clickable areas when exposed by map data.
- Partial discovery and manual-entry fallback.
- Normalization of `22`, `24`, and `22,24` to one canonical purchase target.
- API ID-to-label mapping for home and away events.
- Availability transitions without duplicate alerts.
- Clicking a combined area and completing the standard quantity flow.
- A failed click or failed cart verification producing an alert/link but no false success.
- Backward compatibility with existing section-only monitoring configurations.

## Success Criteria

An invited Telegram user can select an away match, see every area the event page exposes (including unavailable ones), manually add a missing target, monitor that target, and have the requested quantity added to the cart when it becomes available. A combined map area is presented and purchased exactly once, and the bot never reports cart success without verification.
