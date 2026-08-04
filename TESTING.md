# Testing

Run the complete test suite:

```bash
npm test
```

Run it with Node's built-in coverage report:

```bash
npm run test:coverage
```

The tests use Node's built-in test runner, temporary settings directories, and mocked browser/API boundaries. They never use the production `settings.json`, Playwright session, Telegram API, or ticketing site.

## Telegram owner assignment

Run automated coverage without contacting Telegram or the ticketing site:

```bash
npm test
npm run test:coverage
```

Before a supervised live test, use a non-production event/cart, set `desiredQuantity=1`,
confirm the configured Telegram Chat ID belongs to the operator, and stop at the cart link.
Never enter payment data or press the final payment button during verification.

Current automated coverage focuses on:

- section label and internal ID parsing;
- dynamic event-ID extraction and sectors-info API parsing;
- API-first polling, ID mapping, and one-time DOM fallback;
- seat-map load failures and availability transitions;
- Queue-it notification deduplication;
- browser refresh, startup failure, and cleanup behavior;
- settings validation, secret preservation, redaction, and encryption.

The next useful layer is a small Playwright end-to-end fixture using saved local HTML. That would cover selectors, the settings UI, and auto-purchase interaction without accessing the live ticketing site.
