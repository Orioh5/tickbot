# Telegram Owner Assignment Design

## Goal

When a monitored ticket becomes available, the monitor will always attempt to add the configured quantity to the cart. It will then read every person offered by the ticketing site's **שיוך בעלים** control, ask the configured Telegram chat to choose an owner, apply that choice on the ticketing site, and send a direct cart/payment link after the site confirms the assignment.

The automation stops before entering payment details or confirming a purchase.

## User Flow

1. The monitor detects availability in one of the configured visual sections.
2. It opens that section and adds the configured ticket quantity to the cart.
3. It navigates to `/Transaction2/Edit` and pauses normal availability polling so the cart is not disturbed.
4. For each cart ticket that requires an owner, it reads all entries exposed by `.fnAssignDropdownItem` under the site's `.fnAssignButton` control.
5. It sends the configured Telegram chat one inline button per person's display name. Identity numbers are not included in Telegram text or button labels.
6. The user chooses a person. The monitor applies that exact site's internal candidate to the current ticket and waits for the site's `ChangeIdentifier` result and updated ticket state.
7. If the site rejects the person as ineligible, the monitor sends a short failure message and presents the remaining people again, excluding the rejected person.
8. If the assignment succeeds, the next unassigned ticket is presented in the same way.
9. After every required ticket is assigned, the bot sends a direct link to `/Transaction2/Edit` so the user can review the cart and complete payment manually.

No owner is selected automatically. Every assignment is initiated by an explicit Telegram button press.

## Always-On Cart Automation

The **Auto-add to cart** checkbox will be removed from the dashboard. Availability in a configured section will always start the add-to-cart flow.

The legacy `autoPurchase` value may remain readable for backward-compatible settings loading, but monitoring behavior will no longer depend on it. Future saves will not expose or require this setting. `desiredQuantity` remains configurable.

Once tickets enter the cart, the monitor pauses further availability checks regardless of the `pauseOnHit` setting. This protects the active cart and prevents a second cart workflow from racing with owner selection.

## Telegram Interaction

The server will use Telegram Bot API long polling because it works from a local or hosted process without a public webhook URL.

Each owner-selection request contains:

- A random, short-lived nonce.
- The cart ticket index being assigned.
- An in-memory mapping from compact callback IDs to the site's owner identifiers.
- Inline keyboard buttons containing display names only.

Incoming callback queries are accepted only when all of the following match:

- The configured Telegram Chat ID.
- The active request nonce.
- A candidate still available for the current ticket.
- A request that has not already been consumed or expired.

The callback is acknowledged immediately. Stale, duplicate, or foreign-chat callbacks do not change the cart.

Only one owner-selection flow may be active per monitor instance. Telegram webhooks or another process consuming `getUpdates` are treated as a Telegram integration error and trigger the manual fallback.

## Timeout and Fallbacks

An owner-selection request remains active for up to three minutes.

- If no choice arrives in time, the monitor leaves the ticket unassigned, stops automation, and sends the direct cart link for manual handling.
- If Telegram cannot send the keyboard or poll for the response, the monitor sends or logs the direct cart link and does not choose an owner.
- If every listed person is rejected, the monitor sends an explanatory message and the cart link.
- If the owner control is absent because assignment is not required, the flow proceeds directly to the cart link.
- If the cart page or assignment response cannot be verified, the monitor reports the failure and does not claim that assignment succeeded.
- Stopping the monitor cancels an outstanding Telegram wait without applying a late choice.

The automation never presses a final payment button, enters payment data, or confirms an order.

## Browser Assignment Boundary

The browser layer owns all ticket-site interaction:

- Navigate to the cart.
- Discover owner candidates from the site's rendered assignment control.
- Keep the site's identifiers only in memory for the active request.
- Apply the Telegram-selected candidate to the correct cart ticket.
- Observe the site's `/Transaction2/ChangeIdentifier` response and resulting `.fnIdentifier` state.
- Return a structured success, rejection, timeout, or browser-error result.

The Telegram layer never receives DOM selectors or identity numbers. The monitor coordinates the two layers and emits user-facing logs and alerts.

## Privacy and Security

- Owner identity numbers and internal user IDs are never written to settings, logs, test fixtures, or Telegram messages.
- Owner mappings are discarded after success, timeout, cancellation, or monitor shutdown.
- Telegram Bot Token remains server-side and redacted from dashboard responses.
- Only the configured chat can make a selection.
- Callback payloads contain opaque candidate indexes and a nonce, not personal data.

## Dashboard Changes

- Remove the **Auto-add to cart when tickets found** checkbox.
- Keep the desired ticket quantity control.
- Add explanatory text that tickets are automatically added to the cart and owner selection is completed through Telegram.
- Starting monitoring without a configured Telegram token and Chat ID is rejected with a clear message, because owner selection cannot otherwise complete safely.

## Testing

Automated tests will cover:

- Always-on add-to-cart behavior independent of legacy `autoPurchase` settings.
- Extraction and redaction of owner candidates.
- Telegram inline-keyboard payloads without identity numbers.
- Acceptance of the configured chat and rejection of foreign, stale, duplicate, or invalid callbacks.
- Successful owner assignment and checkout-link notification.
- Rejected owner followed by a new keyboard that excludes that owner.
- Exhaustion of all candidates.
- Three-minute timeout and monitor cancellation.
- Telegram send/poll failures and browser verification failures.
- Sequential assignment for multiple tickets.
- No-owner-required carts.
- Regression coverage for availability polling, Queue-it handling, Telegram alerts, and browser cleanup.

Tests will use controlled Telegram and browser boundaries; they will not contact Telegram, modify a real cart, assign a real person, or perform payment.

## Success Criteria

- A found ticket is added to the cart without an Auto Purchase toggle.
- Telegram lists every currently available owner by name and waits for the user's explicit choice.
- An ineligible choice is removed and the user can choose again.
- A verified successful assignment results in a direct cart/payment link.
- No personal identifiers are persisted or sent to Telegram.
- No payment is submitted automatically.
