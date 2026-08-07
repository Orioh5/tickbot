# Personal Web Dashboard Design

## Goal

Turn the existing shared legacy dashboard into a personal dashboard for every user who registered through a Telegram invitation. The website and Telegram bot must be two interfaces to the same user account, saved selection, Maccabi session, and monitor lifecycle.

The website must not create web-only users or a second monitoring system.

## User Model and Source of Truth

`DATA_DIR/bot.db` remains the sole source of truth for registered users. A web account may only be assigned to an existing Telegram user.

The existing user record is extended with:

- a unique normalized web username;
- a salted password hash;
- a web-access enabled/disabled flag;
- timestamps for credential updates and the most recent successful web login.

Plaintext passwords are never persisted or returned. An administrator can replace a password but cannot view the existing one.

Telegram registration and authorization remain authoritative. A revoked or blocked Telegram user cannot access the personal dashboard, even if web credentials were previously assigned.

## Roles and Authentication

### Administrator

The existing `APP_USERNAME` and `APP_PASSWORD` credentials remain the bootstrap administrator login. An authenticated administrator can access the administration panel and administrator APIs.

### Personal user

A registered Telegram user can sign in after an administrator assigns a unique username and password. The authenticated identity is always resolved by the server; personal API routes never trust a Telegram user ID supplied by the browser.

### Sessions

Successful login creates a signed, short-lived, `HttpOnly`, `SameSite=Lax` cookie. Production cookies are also `Secure`. Sessions identify both the role and, for personal users, the corresponding Telegram user ID.

Logging out invalidates the browser cookie. Every protected request re-checks that the account still exists, is Telegram-authorized, and has web access enabled. Disabling or revoking an account therefore takes effect without waiting for the cookie to expire.

Login failures return one generic error whether the username is unknown, the password is wrong, or the account is disabled. Login attempts are rate-limited by both normalized username and client IP.

## Shared Domain Services

The dashboard calls the same services used by the Telegram workflow:

- `UserStore` for registered users, web credentials, and persisted monitor configuration;
- `UserSessionStore` for each user's encrypted Maccabi Playwright storage state;
- game discovery for the available event list;
- `MonitorCoordinator` for browser limits, queueing, start, stop, restoration, and session-expiry cleanup;
- the existing owner-assignment and Telegram notification flow after tickets reach the cart.

No second `Monitor` instance or dashboard-only settings record is created for a personal user. The current legacy shared monitor may remain isolated during migration, but it is not used by the personal dashboard.

## Personal Dashboard Flow

After login, a personal user sees one state-driven workflow:

1. **Maccabi connection** — show whether an encrypted Maccabi session exists and is usable. If connection is missing or expired, request a new one-time browser-login link through the existing secure-login service.
2. **Game selection** — list the games returned by the same discovery service used by Telegram, including an explicit refresh action and an empty state when no games are available.
3. **Section selection** — show the event's real sections and allow the user to select the sections to monitor.
4. **Quantity selection** — accept the same supported quantity range as Telegram.
5. **Review** — show the chosen game, sections, and quantity before starting.
6. **Monitoring** — start through `MonitorCoordinator`, then show active, queued, stopped, failed, session-expired, cart-interaction, owner-selection, and cart-ready states.
7. **Management** — allow the user to stop monitoring or enter the existing confirmation-gated change-selection flow.

The dashboard also shows personal activity messages and live status updates. When tickets are found, the existing Telegram alert and owner-selection workflow continue unchanged. Payment remains manual and outside the dashboard automation.

## Synchronization Between Website and Telegram

The saved monitor configuration and coordinator state are shared, so either interface can initiate a valid transition.

- A selection saved on the website is immediately visible to Telegram status and change-selection actions.
- A selection changed in Telegram is immediately reflected on the website.
- Start and stop actions from either interface operate on the same coordinator entry and cannot create duplicate monitors.
- Queue position and monitor phase are derived from `MonitorCoordinator`, not reconstructed in the browser.

The server publishes user-scoped real-time events over authenticated WebSocket connections. Each connection receives only events for its resolved user. Administrator connections may receive aggregate status updates but never secrets or encrypted session contents.

Initial page load always fetches a complete authenticated snapshot. WebSocket messages then update it incrementally, so reconnecting or missing an event cannot permanently desynchronize the UI.

## Administration Panel

The administrator panel lists users who completed Telegram invitation registration. Each row includes:

- Telegram display information and Telegram user ID;
- whether a Maccabi session exists;
- whether web credentials have been configured;
- whether web access is enabled;
- monitor state: active, queued, or stopped;
- latest successful web login or activity timestamp when available.

Administrator actions are:

- assign an initial unique username and password;
- change the username;
- reset the password;
- enable or disable web access without deleting the user;
- stop an active or queued monitor;
- open a read-only operational status view.

The panel never exposes password hashes, plaintext passwords, Maccabi cookies, Playwright storage state, bot tokens, encryption keys, or other secret settings.

## API Boundaries

The server exposes separate authenticated route groups:

- authentication routes for login, logout, and current-session identity;
- personal routes that infer the Telegram user ID exclusively from the session;
- administrator routes protected by an explicit administrator authorization check.

Personal routes cover Maccabi connection state/link creation, game discovery, current selection, selection updates, monitor start/stop, and a complete dashboard snapshot. Administrator routes cover user listing, web credential assignment/reset, web-access toggling, and emergency monitor stop.

Validation rules live at the service boundary and are shared with Telegram wherever the same transition exists. HTTP handlers translate domain errors into stable status codes and safe user-facing messages.

## UI Structure

The public frontend remains build-free vanilla HTML, CSS, and JavaScript unless implementation reveals a concrete need to change that constraint.

The authenticated shell is role-aware:

- personal users land on the personal dashboard workflow;
- the bootstrap administrator lands on user management;
- both roles have a visible logout action.

The interface is responsive, supports Hebrew right-to-left presentation, and uses explicit loading, empty, success, and failure states. Buttons are disabled while their action is pending, and repeated submissions remain safe on the server.

## Error Handling

The UI provides a clear recovery action for each expected failure:

- missing or expired Maccabi session: create a new secure login link;
- no available games: refresh discovery or return later;
- browser capacity reached: show queued state and current position when available;
- monitor start conflict: refresh the authoritative snapshot;
- discovery or monitor failure: show a safe error and allow retry;
- network or WebSocket interruption: show disconnected state, reconnect, and fetch a fresh snapshot;
- authorization loss: clear the local UI state and return to login.

Internal errors and secrets are logged only on the server. API responses contain stable safe messages.

## Migration and Compatibility

Existing Telegram users, encrypted Maccabi sessions, monitor selections, and active/queued monitor restoration continue to work. Schema migration adds nullable web-authentication fields so existing users require no manual data conversion.

The bootstrap administrator remains available through environment credentials. The existing Telegram invitation flow remains the only way to create a user eligible for personal web access.

The legacy shared dashboard routes and settings must not accidentally grant access to personal-user data. During implementation they will either remain administrator-only and clearly separated or be retired after equivalent administrator functionality is verified.

## Testing and Verification

Automated tests cover:

- username normalization and uniqueness;
- password hashing, verification, reset, and non-disclosure;
- login, logout, cookie validation, expiry, and rate limiting;
- immediate denial after web access is disabled or Telegram authorization is revoked;
- administrator route authorization;
- strict user isolation across REST and WebSocket boundaries;
- personal game, section, quantity, review, start, stop, and change-selection transitions;
- synchronization when transitions originate from either Telegram or the website;
- duplicate-start prevention and coordinator queue behavior;
- process restart restoration and session-expiry recovery;
- safe API errors and complete-snapshot recovery after reconnect;
- frontend state rendering for loading, empty, queued, active, error, disconnected, and authorization-loss states.

A local smoke test uses an isolated temporary `DATA_DIR` and non-production secrets. It verifies administrator login, credential assignment to a registered fixture user, personal login, dashboard loading, user isolation, and start/stop calls against mocked discovery and monitor boundaries. It does not access the live ticketing site, send Telegram messages, or perform payment actions.

## Success Criteria

The feature is complete when:

- an administrator can assign and manage website credentials for an existing Telegram-registered user;
- that user can log in and complete the same selection and monitoring workflow available in Telegram;
- actions from the website and Telegram always address one shared configuration and one shared monitor;
- users cannot read or mutate another user's state;
- revocation and web-access disabling are enforced on the next request;
- real-time status remains correct after reconnects and process restarts;
- existing Telegram workflows and security properties continue to pass their automated tests.
