# Inline Telegram Section Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update section selections inside the original Telegram inline keyboard without sending a second message.

**Architecture:** Keep conversation state and keyboard generation in `TelegramBotService`. On a `section:*` callback, persist the toggled selection and call Telegram's `editMessageReplyMarkup` with the callback message identifiers and the rebuilt keyboard. Contain edit failures so state remains authoritative and the chat is not flooded with fallback messages.

**Tech Stack:** Node.js 24, CommonJS, Telegram Bot API, built-in `node:test` and `node:assert`.

## Global Constraints

- Do not send a new selection-summary message after a section toggle.
- Selected buttons display `✅` and the existing finish button displays the selected count.
- An edit failure preserves conversation state and sends no fallback selection message.
- Existing empty-selection validation and quantity flow remain unchanged.
- Do not add dependencies.

---

### Task 1: Edit the original section keyboard

**Files:**
- Modify: `test/telegram-bot-service.test.js:34-45, 715-740`
- Modify: `bot/telegram-bot-service.js:126-132, 638-655`

**Interfaces:**
- Consumes: Telegram callback queries containing `query.message.chat.id` and `query.message.message_id`.
- Produces: `TelegramBotService.editMessageReplyMarkup(chatId, messageId, replyMarkup): Promise<object>`.
- Preserves: `_buildSectionsKeyboard({ availableSections, sections }): Array<Array<Button>>` as the sole keyboard builder.

- [ ] **Step 1: Write the failing tests**

Update the callback fixture so Telegram message identity is available:

```js
function makeCallbackUpdate(userId, data, updateId = 2) {
  return {
    update_id: updateId,
    callback_query: {
      id: 'cq1',
      from: { id: userId },
      message: { message_id: 77, chat: { id: userId, type: 'private' } },
      data,
    },
  };
}
```

Add focused tests next to the existing section-selection test:

```js
test('section selection edits the original keyboard without sending a selection message', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: {} });
  const fetch = makeFetch([
    { ok: true, result: {} },
    { ok: true, result: {} },
  ]);
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_sections', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    availableSections: ['13', '14'],
    sections: [],
  });

  await bot._dispatch(makeCallbackUpdate(7, 'section:13'));

  assert.deepEqual(fetch.calls.map(call => call.method), [
    'answerCallbackQuery',
    'editMessageReplyMarkup',
  ]);
  assert.equal(fetch.calls[1].body.chat_id, '7');
  assert.equal(fetch.calls[1].body.message_id, 77);
  const buttons = fetch.calls[1].body.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.find(button => button.callback_data === 'section:13').text, '✅ 13');
  assert.equal(buttons.find(button => button.callback_data === 'sections_done').text, '✅ סיימתי (1)');
});

test('section keyboard edit failure preserves selection without a fallback message', async () => {
  const { botFactory } = makeBot({ extraUserIds: ['7'], monitorCoordinator: {} });
  const fetch = makeFetch([
    { ok: true, result: {} },
    { ok: false, description: 'message is not modified' },
  ]);
  const bot = botFactory(fetch);
  bot._setState('7', 'awaiting_sections', {
    gameUrl: 'https://tickets.mhaifafc.com/game/1',
    availableSections: ['13'],
    sections: [],
  });

  await assert.doesNotReject(() => bot._dispatch(makeCallbackUpdate(7, 'section:13')));

  assert.deepEqual(bot._getState('7').data.sections, ['13']);
  assert.deepEqual(fetch.calls.map(call => call.method), [
    'answerCallbackQuery',
    'editMessageReplyMarkup',
  ]);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='section selection edits|section keyboard edit failure' test/telegram-bot-service.test.js
```

Expected: the first test fails because the implementation calls `sendMessage`; the second fails because the rejected edit is not yet contained.

- [ ] **Step 3: Add the Telegram edit wrapper**

Place this beside `sendMessage`:

```js
async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  return this._call('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}
```

- [ ] **Step 4: Replace the section-selection message with an in-place edit**

After updating `current.data.sections`, replace the existing `sendMessage` call with:

```js
await this.editMessageReplyMarkup(
  chatId,
  query.message?.message_id,
  { inline_keyboard: this._buildSectionsKeyboard(current.data) }
).catch(() => {
  console.error('[TelegramBotService] section keyboard edit failed code=TELEGRAM_EDIT_FAILED.');
});
```

Do not add a fallback `sendMessage`; state already contains the accepted choice.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern='section selection edits|section keyboard edit failure' test/telegram-bot-service.test.js
```

Expected: both focused tests pass.

- [ ] **Step 6: Verify deselection and the existing flow**

Extend the first test with a second `section:13` callback and two successful API responses, then assert that the second edited keyboard shows `13` and `✅ סיימתי (0)`. Run:

```bash
node --test test/telegram-bot-service.test.js
```

Expected: all Telegram bot service tests pass, including quantity and confirmation tests.

- [ ] **Step 7: Run repository verification**

Run:

```bash
npm run test:coverage
```

Expected: the complete test suite passes with zero failures.

- [ ] **Step 8: Commit only the implementation files**

```bash
git add bot/telegram-bot-service.js test/telegram-bot-service.test.js
git commit -m "feat: update Telegram section selection inline"
```

Do not stage `.claude/settings.local.json`, `.github/workflows/test.yml`, `.superpowers/`, or the unrelated game-discovery working-tree changes.
