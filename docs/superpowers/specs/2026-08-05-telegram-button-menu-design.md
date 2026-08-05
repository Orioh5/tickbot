# Telegram Button Menu Design

## Goal

Replace the bot's command-driven user experience with contextual inline keyboards. After entering through an invitation link, a normal user can complete registration, login, game selection, section selection, quantity selection, monitoring, and recovery without typing commands or free-form text.

Text commands remain available temporarily for maintenance and backward compatibility, but the bot never requires a normal user to know them.

## Interaction Model

`BotMenu` is the single component responsible for rendering actions. It derives the available buttons from the persisted user record, encrypted session availability, and `MonitorCoordinator` status.

Menus by state:

- Unknown user: no operational buttons; explain that a valid invitation link is required.
- Registered user without a saved session: `🔐 התחבר`.
- Connected user without monitoring: `⚽ בחר משחק`, `📊 סטטוס`.
- Queued monitoring: `📊 סטטוס`, `⏹ בטל`.
- Active monitoring: `📊 סטטוס`, `⏹ עצור`, `⚙️ שנה בחירה`.
- Administrator: add `➕ הזמן משתמש` and `👥 משתמשים` to the applicable menu.

The callback namespace is explicit and stable:

- `menu:login`
- `menu:games`
- `menu:status`
- `menu:stop`
- `menu:change`
- `admin:invite`
- `admin:users`

Every callback revalidates the Telegram user, private-chat requirement, revocation state, current conversation state, and monitor state. A stale or duplicate button cannot start a second monitor or bypass authorization. Invalid callbacks redisplay the current menu without mutating state.

Free-form text outside the invitation fallback does not perform actions. It redisplays the contextual menu. Existing slash commands route through the same action handlers as buttons so behavior cannot diverge.

## Invitation Flow

The administrator presses `➕ הזמן משתמש`. The bot creates a single-use invitation and returns a Telegram deep link:

```text
https://t.me/<bot-username>?start=<invite-code>
```

The bot obtains its public username from Telegram `getMe` at startup and does not require another environment variable.

When the invited person opens the link, Telegram sends `/start <invite-code>`. The bot atomically redeems the code, binds it to that Telegram User ID, and shows the connected user's menu. Used, invalid, or expired codes do not register a user. Manual invite-code entry is removed from the normal flow.

Invitation codes remain short-lived and single-use. The existing ten-active-user limit is enforced at both invitation creation and redemption.

## Login Flow

The user presses `🔐 התחבר`. The bot sends the existing one-time web login URL. The web form authenticates against `https://auth.mhaifafc.com/login`, verifies that the login form disappeared and a browser session exists, encrypts the user's Playwright `storageState`, and consumes the login token only after verified success.

After the session is saved, the web route asks `TelegramBotService` to send a success message directly to the same user with an inline `⚽ בחר משחק` button and `🏠 תפריט ראשי`. The browser page still displays a success confirmation in case Telegram delivery fails.

If login fails, credentials are discarded, the token remains usable until expiry, and the browser shows a generic retry message. Credentials, cookies, tokens, and storage state never appear in Telegram or application logs.

## Monitoring Setup Flow

1. `⚽ בחר משחק` discovers games with the user's encrypted session.
2. The user chooses a game from inline buttons.
3. The bot discovers real section labels from the live event page.
4. Sections are grouped by a verified stadium mapping when possible. Unmapped real labels appear under `גושים מהמפה`; fake dashboard section numbers are never used as monitoring IDs.
5. Section buttons toggle selection and `✅ סיימתי` advances only when at least one section is selected.
6. Quantity is selected using exactly four buttons: `1`, `2`, `3`, `4`.
7. A final summary shows game, sections, and quantity with `▶️ התחל מעקב`, `⬅️ חזור`, and `❌ ביטול`.
8. Monitoring starts immediately or enters the bounded browser queue. The resulting menu reflects the actual state.

Changing a selection stops or removes the existing monitor only after explicit confirmation, then returns to game selection.

## Monitoring and Cart Actions

When matching tickets appear, the monitor adds the configured quantity to the cart immediately. Normal polling pauses for that user. The bot asks for an owner for each ticket using existing nonce-protected inline keyboards, verifies each assignment on the ticketing site, and sends the direct cart link. It never performs payment.

If no owner response arrives within three minutes, the bot leaves the cart for manual handling, sends the cart link, and keeps monitoring paused. Telegram send failures fail immediately rather than waiting for the selection timeout.

## Session Expiry and Error Handling

- Expired session: stop only that user's monitor, mark it inactive, and show `🔐 התחבר מחדש`.
- No games: show `🔄 בדוק שוב` and `🏠 תפריט ראשי`.
- Queue full: persist the monitoring configuration, show queued status, and start automatically when capacity is available.
- Process restart: restore persisted active and queued monitors subject to the concurrency limit.
- Revocation: stop and remove the user's monitor, discard queued work, delete the encrypted session, clear callbacks and conversation state, and deny future actions.
- Stale callback: acknowledge it and redisplay the current contextual menu without mutation.
- Telegram or Playwright error: remove transient handlers, keep persisted state consistent, and show a safe Hebrew message without secrets or site identifiers.

## Components

- `BotMenu`: pure contextual keyboard and message generation.
- `TelegramBotService`: polling, authorization, action dispatch, conversation state, and callback acknowledgement.
- `SecureLoginService`: one-time login-token lifecycle.
- `MaccabiAuthenticator`: verified browser login and storage-state creation.
- `UserSessionStore`: encrypted session persistence and existence checks.
- `UserStore`: users, invitations, monitoring configuration, and durable state.
- `GameDiscoveryService`: live game and section discovery.
- `MonitorCoordinator`: one monitor per user, bounded queue, restoration, and lifecycle cleanup.

The web login route receives a narrow notifier interface rather than importing or controlling the bot directly.

## Security and Privacy

- Bot interaction is allowed only in private chats.
- Telegram User ID is the authorization identity; Chat ID alone is insufficient.
- Invitation and login tokens are single-use and stored only as hashes.
- Credentials live only for the duration of one authentication attempt.
- Saved sessions use AES-256-GCM with the required stable encryption key.
- Callback payloads contain action names, indexes, opaque owner keys, and nonces—not credentials or identity numbers.
- Every action performs server-side authorization and state validation even when the button was originally generated for that user.

## Testing

Automated tests cover:

- Contextual menus for unknown, unconnected, connected, queued, active, revoked, and administrator states.
- Deep-link generation using the bot username returned by `getMe`.
- Atomic acceptance and rejection of valid, invalid, expired, used, and over-capacity invitations.
- Button callbacks for login, games, status, stop, change, invite, and users.
- Free text redisplaying the menu without changing state.
- Stale and duplicate callbacks, including prevention of duplicate monitors.
- Automatic Telegram notification after verified web login.
- Login failure preserving the unexpired token and never saving a session.
- Game, section, quantity, confirmation, queue, owner-selection, and cart recovery flows.
- Session expiry, revocation, restart restoration, and cross-user isolation.
- Regression coverage for existing monitoring, availability detection, cart verification, owner assignment, and encrypted storage.

Tests use controlled Telegram and Playwright boundaries. They do not contact Telegram, authenticate a real account, modify a real cart, or submit payment.

## Acceptance Criteria

- An invited normal user can complete the entire supported flow after clicking the deep link without typing any command or free-form response.
- Menus always match the user's current persisted and runtime state.
- Successful web login automatically returns the user to the next Telegram action.
- Old or repeated buttons cannot bypass authorization or create duplicate work.
- Real section labels—not fake dashboard numbers—are stored for monitoring.
- Existing session isolation, encryption, owner privacy, and no-payment guarantees remain intact.
