// Load environment variables from .env file
require("dotenv").config();

// watch-mhaifa.js - Refactored & Improved
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-extra");

// ============================================================================
// Configuration from Environment Variables
// ============================================================================

// DEBUG flag (supports: 1/true/yes/on)
const DEBUG = process.env.DEBUG === "1";

const HEADFUL = process.env.HEADFUL === "1";
const PAUSE_ON_HIT = process.env.PAUSE_ON_HIT !== "0"; // default: true

// Event URL and sections
const URL =
  process.env.URL || "https://tickets.mhaifafc.com/Stadium/Index?eventId=5230";
const SECTIONS_ENV = process.env.SECTIONS;
const SECTIONS = SECTIONS_ENV
  ? SECTIONS_ENV.split(",").map((s) => s.trim())
  : Array.from({ length: 12 }, (_, i) => String(201 + i)); // 201..212 default
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 1_000);

// Notifications
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

// Login credentials
const LOGIN_USERNAME = process.env.LOGIN_USERNAME || "";
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || "";
const LOGIN_URL = process.env.LOGIN_URL || "https://auth.mhaifafc.com/";

// Viewport settings
const VIEWPORT_W = Number(process.env.VIEWPORT_W || 1366);
const VIEWPORT_H = Number(process.env.VIEWPORT_H || 768);
const DEVICE_SCALE_FACTOR = Number(process.env.DEVICE_SCALE_FACTOR || 1);

// Session storage
const STORAGE_STATE_PATH = process.env.STORAGE_STATE_PATH || "./state.json";

// Category name (for filtering sections)
const CATEGORY_NAME = process.env.CATEGORY_NAME || "יציע אבי רן עליון";
const CATEGORY_TEXTS = [
  CATEGORY_NAME,
  CATEGORY_NAME.replace("יציע ", ""),
  CATEGORY_NAME.replace(" עליון", ""),
  "אבי רן עליון",
  "אבי רן",
].filter((text, index, self) => self.indexOf(text) === index);

// Proxy support
const PROXY_SERVER = process.env.PROXY_SERVER || ""; // e.g., "http://proxy.example.com:8080"
const PROXY_USERNAME = process.env.PROXY_USERNAME || "";
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || "";

// API monitoring
const API_MONITORING_ENABLED = process.env.API_MONITORING !== "0"; // default: true

// ============================================================================
// Playwright / playwright-extra selection
// ============================================================================

let pw;

try {
  const playwrightExtra = require("playwright-extra");
  const stealthPlugin = require("playwright-extra-plugin-stealth");
  playwrightExtra.use(stealthPlugin());
  pw = playwrightExtra;

  if (DEBUG) console.log("✅ Using playwright-extra with stealth plugin");
} catch (e) {
  pw = require("playwright");
  if (DEBUG)
    console.log("⚠️ playwright-extra not installed, using standard Playwright");
}

// ============================================================================
// Node.js Version Check & Fetch Setup
// ============================================================================

function checkNodeVersion() {
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split(".")[0], 10);

  if (major < 18) {
    console.log("⚠️  Node.js < 18 detected. Installing node-fetch...");
    try {
      require("node-fetch");
    } catch (e) {
      console.error(
        "❌ node-fetch is required for Node < 18. Install it: npm install node-fetch",
      );
      process.exit(1);
    }
  } else {
    // Node >= 18 has global fetch
    if (typeof fetch === "undefined") {
      console.error(
        "❌ fetch is not available. Please use Node.js >= 18 or install node-fetch",
      );
      process.exit(1);
    }
  }
}

checkNodeVersion();

// ============================================================================
// Utility Functions
// ============================================================================

async function notifyRemote(message) {
  const tasks = [];

  if (NTFY_TOPIC) {
    const url = `https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`;
    tasks.push(
      fetch(url, {
        method: "POST",
        headers: {
          Title: "MHFC Tickets",
          Priority: "5",
          Tags: "ticket,alert",
          Click: URL,
        },
        body: message,
      }).catch(
        (e) => DEBUG && console.log("ntfy notify failed:", e?.message || e),
      ),
    );
  }

  if (WEBHOOK_URL) {
    tasks.push(
      fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `🔥 **${message}**`,
          embeds: [
            {
              title: "Tickets available!",
              description: message,
              color: 0xff0000,
              url: URL,
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      }).catch(
        (e) => DEBUG && console.log("webhook notify failed:", e?.message || e),
      ),
    );
  }

  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const telegramMessage = `🔥 ${message}\n\n${URL}`;

    tasks.push(
      fetch(telegramUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: telegramMessage,
          disable_web_page_preview: false,
        }),
      })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok || !data.ok) {
            console.log(
              `❌ Telegram error: ${data.description || response.statusText}`,
            );
            if (data.error_code) {
              if (data.error_code === 401) {
                console.log("   ⚠️  Invalid bot token - check TELEGRAM_TOKEN");
              } else if (data.error_code === 400) {
                console.log("   ⚠️  Invalid chat ID or message format!");
              } else if (data.error_code === 403) {
                console.log(
                  "   ⚠️  Bot blocked or chat not found - make sure you've started a conversation with the bot",
                );
              }
            }
            if (DEBUG)
              console.log(`   Full response: ${JSON.stringify(data, null, 2)}`);
          } else {
            console.log("✅ Telegram message sent successfully");
          }
          return data;
        })
        .catch((e) => {
          console.log(`❌ Telegram notify failed: ${e?.message || e}`);
          if (DEBUG) {
            console.log(`   URL: ${telegramUrl.substring(0, 50)}...`);
            console.log(`   Chat ID: ${TELEGRAM_CHAT_ID}`);
          }
        }),
    );
  } else {
    if (DEBUG) {
      console.log("⚠️  Telegram not configured:");
      if (!TELEGRAM_TOKEN) console.log("   - TELEGRAM_TOKEN is missing");
      if (!TELEGRAM_CHAT_ID) console.log("   - TELEGRAM_CHAT_ID is missing");
    }
  }

  await Promise.all(tasks);
}

// ============================================================================
// Telegram Test Function
// ============================================================================

async function testTelegram() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("⚠️  Telegram not configured - skipping test");
    return false;
  }

  try {
    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const testMessage = `🧪 בדיקת בוט MHFC\n\nהבוט מוכן ומחפש כרטיסים ב${CATEGORY_NAME}`;

    console.log(`   Sending test message to chat ${TELEGRAM_CHAT_ID}...`);

    const response = await fetch(telegramUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: testMessage,
      }),
    });

    const data = await response.json();

    if (response.ok && data.ok) {
      console.log("✅ Telegram test message sent successfully!");
      return true;
    } else {
      const hint =
        data.error_code === 401 ? "Invalid bot token - check TELEGRAM_TOKEN" :
        data.error_code === 400 ? "Invalid chat ID - start a conversation with the bot first" :
        data.error_code === 403 ? "Bot blocked or chat not found - start a conversation with the bot" :
        data.description || response.statusText;
      console.log(`❌ Telegram test failed: ${hint}`);
      if (DEBUG) console.log(`   Full error response: ${JSON.stringify(data)}`);
      return false;
    }
  } catch (e) {
    console.log(`❌ Telegram test error: ${e?.message || e}`);
    if (DEBUG) console.log(`   Stack: ${e.stack}`);
    return false;
  }
}

// ============================================================================
// Browser & Context Setup
// ============================================================================

async function createBrowserAndContext() {
  const launchOpts = {
    headless: !HEADFUL,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
  };

  // Optional proxy
  if (PROXY_SERVER) {
    launchOpts.proxy = {
      server: PROXY_SERVER,
      username: PROXY_USERNAME || undefined,
      password: PROXY_PASSWORD || undefined,
    };
  }

  const browser = await pw.chromium.launch(launchOpts);

  // Load storage state if exists
  const storageState = fs.existsSync(STORAGE_STATE_PATH)
    ? JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, "utf8"))
    : undefined;

  const context = await browser.newContext({
    viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    permissions: ["geolocation"],
    storageState,
    extraHTTPHeaders: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br",
      DNT: "1",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Cache-Control": "max-age=0",
    },
  });

  return { browser, context };
}

function applyStealth(page) {
  // גם אם יש stealth plugin, זה לא מזיק להשאיר (ואם אין - זה עוזר)
  return page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });

    window.chrome = {
      runtime: {},
      loadTimes: function () {},
      csi: function () {},
      app: {},
    };

    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });

    Object.defineProperty(navigator, "languages", {
      get: () => ["he-IL", "he", "en-US", "en"],
    });

    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);

    Object.defineProperty(navigator, "platform", {
      get: () => "Win32",
    });

    Object.defineProperty(navigator, "hardwareConcurrency", {
      get: () => 8,
    });

    Object.defineProperty(navigator, "deviceMemory", {
      get: () => 8,
    });
  });
}

async function saveStorageState(context) {
  try {
    await context.storageState({ path: STORAGE_STATE_PATH });
    if (DEBUG) console.log(`💾 Session saved to ${STORAGE_STATE_PATH}`);
  } catch (e) {
    console.log(`⚠️  Failed to save session: ${e?.message || e}`);
  }
}

// ============================================================================
// Login Functions
// ============================================================================

async function findUsernameField(page) {
  const usernameSelectors = [
    'input[type="email"]',
    'input[name*="user" i]',
    'input[name*="email" i]',
    'input[id*="user" i]',
    'input[id*="email" i]',
    'input[placeholder*="user" i]',
    'input[placeholder*="email" i]',
  ];

  for (const selector of usernameSelectors) {
    const field = page.locator(selector).first();
    if ((await field.count()) > 0) return field;
  }

  const allInputs = await page.locator("input").all();
  for (let i = 0; i < allInputs.length; i++) {
    const inp = allInputs[i];
    const type = await inp.getAttribute("type");
    if (type === "password" && i > 0) {
      return page.locator("input").nth(i - 1);
    }
  }

  return null;
}

async function performLogin(page, skipGoto = false) {
  if (!LOGIN_USERNAME || !LOGIN_PASSWORD) {
    if (DEBUG) console.log("⚠️  אין פרטי התחברות - מדלג על login");
    return false;
  }

  try {
    if (LOGIN_URL && !skipGoto) {
      await page.waitForTimeout(1000 + Math.random() * 1000);
      await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(2000);
    }

    const passwordField = page.locator('input[type="password"]').first();
    const passwordCount = await passwordField.count();

    if (DEBUG) console.log(`   נמצאו ${passwordCount} שדות סיסמה`);

    if (passwordCount === 0) {
      if (DEBUG)
        console.log(
          "⚠️  Password field not found - probably already logged in",
        );
      return false;
    }

    const usernameField = await findUsernameField(page);

    if (!usernameField || (await usernameField.count()) === 0) {
      console.log("❌ Username field not found");
      if (DEBUG) {
        const currentUrl = await page.url();
        console.log(`   URL נוכחי: ${currentUrl}`);
        const allInputsCount = await page.locator("input").count();
        console.log(`   סך הכל ${allInputsCount} שדות input בדף`);
      }
      return false;
    }

    if (DEBUG) console.log("   ממלא פרטי התחברות...");
    await usernameField.fill(LOGIN_USERNAME);
    await page.waitForTimeout(500);
    await passwordField.fill(LOGIN_PASSWORD);
    await page.waitForTimeout(500);

    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("התחבר")',
      'button:has-text("Login")',
      'button:has-text("כניסה")',
      'input[type="submit"]',
      "form button",
    ];

    let submitted = false;
    for (const selector of submitSelectors) {
      try {
        const btn = page.locator(selector).first();
        if ((await btn.count()) > 0) {
          if (DEBUG) console.log(`   לוחץ על כפתור: ${selector}`);
          await btn.click();
          submitted = true;
          break;
        }
      } catch (e) {
        if (DEBUG)
          console.log(`   Failed selector ${selector}: ${e?.message || e}`);
      }
    }

    if (!submitted) {
      if (DEBUG) console.log("   Button not found - trying Enter");
      await passwordField.press("Enter");
    }

    await page.waitForTimeout(3000);

    const currentUrl = await page.url();
    const isStillOnLoginPage =
      currentUrl.includes("auth.mhaifafc.com") || currentUrl.includes("/login");
    const stillHasPassword =
      (await page.locator('input[type="password"]').count()) > 0;
    const hasError = (await page.locator("text=/error|failed/i").count()) > 0;

    if (isStillOnLoginPage && stillHasPassword && !hasError) {
      await page.waitForTimeout(2000);
      const stillHasPassword2 =
        (await page.locator('input[type="password"]').count()) > 0;
      const currentUrl2 = await page.url();
      const isStillOnLoginPage2 =
        currentUrl2.includes("auth.mhaifafc.com") ||
        currentUrl2.includes("/login");

      if (isStillOnLoginPage2 && stillHasPassword2) {
        console.log("⚠️  It seems that the connection failed.");
        return false;
      }
    }

    if (hasError) {
      console.log("⚠️  There seems to be an error message on the page.");
      return false;
    }

    return true;
  } catch (e) {
    console.log(`❌ Connection error: ${e?.message || e}`);
    return false;
  }
}

async function ensureLoggedIn(page, context) {
  if (!LOGIN_USERNAME || !LOGIN_PASSWORD) return true;

  try {
    await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(2000);
  } catch (e) {
    console.log(`⚠️  שגיאה בטעינת דף התחברות: ${e?.message || e}`);
  }

  const hasPasswordField =
    (await page.locator('input[type="password"]').count()) > 0;
  if (!hasPasswordField) {
    console.log("✅ It appears you are already logged in (no password field)");
    return true;
  }

  console.log("🔐 Trying to connect...");
  if (DEBUG) {
    console.log(`   Username: ${LOGIN_USERNAME}`);
    console.log(`   Login URL: ${LOGIN_URL}`);
  }

  const success = await performLogin(page, true);
  if (success) {
    await saveStorageState(context);
    console.log("✅ Login successful!");
  } else {
    console.log("❌ Connection error");
  }
  return success;
}

// ============================================================================
// Page Loading & Interaction
// ============================================================================

async function waitForMapReady(page) {
  const mapSelectors = [
    "canvas",
    "svg",
    '[class*="map"]',
    '[id*="map"]',
    '[class*="stadium"]',
    '[id*="stadium"]',
    "iframe",
  ];

  try {
    await Promise.race([
      Promise.all(
        mapSelectors.map((sel) =>
          page.waitForSelector(sel, { timeout: 3000 }).catch(() => null),
        ),
      ),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch {}
}

async function interactWithPage(page) {
  await page.mouse.move(100, 100);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.scrollTo(0, 100);
    setTimeout(() => window.scrollTo(0, 0), 500);
  });
  await page.waitForTimeout(1000);
}

async function openEventPage(page) {
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
  await page.goto(URL, { waitUntil: "networkidle", timeout: 60_000 });
  await interactWithPage(page);
  await waitForMapReady(page);

  try {
    await page.mouse.click(400, 300);
    await page.waitForTimeout(1000);
  } catch {}
}

// ============================================================================
// Availability Detection
// ============================================================================

function looksAvailable(meta) {
  const hay =
    `${meta.className} ${meta.ariaDisabled} ${meta.disabled} ${meta.style}`.toLowerCase();

  if (
    hay.includes("sold") ||
    hay.includes("unavail") ||
    hay.includes("disabled") ||
    hay.includes("lock")
  ) {
    return false;
  }
  if (meta.ariaDisabled === "true" || meta.disabled === true) return false;
  if (
    hay.includes("avail") ||
    hay.includes("select") ||
    hay.includes("enabled")
  )
    return true;

  return null;
}

const SUCCESS_INDICATORS = [
  'button:has-text("הוסף לעגלה")',
  'button:has-text("המשך")',
  'button:has-text("Continue")',
  'input[type="number"]',
  '[class*="quantity"]',
  '[class*="seat"]',
  '[class*="modal"]',
  '[class*="panel"]',
  '[id*="modal"]',
  '[id*="panel"]',
];

async function confirmHitByClick(page, section) {
  if (!HEADFUL) return false;

  try {
    const sectionElement = page.getByText(section, { exact: true }).first();
    if ((await sectionElement.count()) === 0) return false;

    await sectionElement.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    await sectionElement.evaluate((el) => {
      let current = el;
      for (let i = 0; i < 5; i++) {
        if (!current) break;
        const tag = current.tagName?.toLowerCase();
        const style = window.getComputedStyle(current);
        const cursor = style.cursor;
        const pointerEvents = style.pointerEvents;

        if (
          tag === "button" ||
          tag === "a" ||
          cursor === "pointer" ||
          (pointerEvents !== "none" && current.onclick)
        ) {
          current.click();
          return;
        }
        current = current.parentElement;
      }
      el.click();
    });

    await page.waitForTimeout(1500);

    for (const selector of SUCCESS_INDICATORS) {
      try {
        const element = page.locator(selector).first();
        if ((await element.count()) > 0) {
          const isVisible = await element.isVisible().catch(() => false);
          if (isVisible) {
            console.log(`✅ Found success indicator: ${selector}`);
            return true;
          }
        }
      } catch {}
    }

    return false;
  } catch (e) {
    if (DEBUG) console.log(`⚠️  Error confirming hit: ${e?.message || e}`);
    return false;
  }
}

  let notifiedCategoryFound = false;

async function scanSections(page) {
  // Find the category "יציע אבי רן עליון"
  const categoryTexts = CATEGORY_TEXTS;

  let categoryFound = false;
  let categoryElement = null;

  // Try to find the category
  for (const categoryText of categoryTexts) {
    try {
      const categoryLoc = page
        .getByText(categoryText, { exact: false })
        .first();
      const categoryCount = await categoryLoc.count();

      if (categoryCount > 0) {
        categoryElement = categoryLoc;
        categoryFound = true;
        if (DEBUG) console.log(`✅ Found category: "${categoryText}"`);

        if (!notifiedCategoryFound) {
          await notifyRemote(`✅ יש כרטיסים ב "${CATEGORY_NAME}" `);
          notifiedCategoryFound = true;
        }

        break;
      }
    } catch (e) {
      if (DEBUG)
        console.log(
          `⚠️  Error finding category "${categoryText}": ${e?.message || e}`,
        );
    }
  }

  if (!categoryFound) {
    console.log(`⚠️  Category '${CATEGORY_NAME}' not found!`);
    notifiedCategoryFound = false;
    return [{ sec: "category", found: false, avail: false }];
  }

  // Check for availability within the category
  let hasAvailability = false;
  let availabilityDetails = null;

  try {
    // Get the container element and check for available seats
    const availabilityCheck = await categoryElement.evaluate((el) => {
      // Find the container (parent element that contains the seats)
      let container = el;
      for (let i = 0; i < 10; i++) {
        if (!container) break;
        const tag = container.tagName?.toLowerCase();
        const className = container.className || "";

        if (
          tag === "div" ||
          tag === "section" ||
          tag === "article" ||
          className.includes("section") ||
          className.includes("category") ||
          className.includes("stand") ||
          className.includes("tribune") ||
          className.includes("area") ||
          className.includes("zone") ||
          className.includes("block") ||
          className.includes("box")
        ) {
          break;
        }
        container = container.parentElement;
      }

      if (!container) container = el.parentElement || el;

      // Look for clickable elements that might indicate availability
      const clickableElements = container.querySelectorAll(
        'button, a, [role="button"], [onclick], [class*="click"], [class*="select"], [class*="seat"], [class*="ticket"], [class*="available"]',
      );

      for (const el of clickableElements) {
        const style = window.getComputedStyle(el);
        const className = el.className || "";
        const ariaDisabled = el.getAttribute("aria-disabled");
        const disabled = el.hasAttribute("disabled");
        const pointerEvents = style.pointerEvents;
        const cursor = style.cursor;
        const opacity = parseFloat(style.opacity);
        const display = style.display;

        // Check if element is available (not disabled, visible, clickable)
        if (
          display !== "none" &&
          ariaDisabled !== "true" &&
          !disabled &&
          pointerEvents !== "none" &&
          opacity > 0.5 &&
          (cursor === "pointer" ||
            className.toLowerCase().includes("avail") ||
            className.toLowerCase().includes("select") ||
            className.toLowerCase().includes("enabled") ||
            className.toLowerCase().includes("active") ||
            className.toLowerCase().includes("open"))
        ) {
          // Check if it's NOT sold/disabled
          const text = el.textContent?.toLowerCase() || "";
          const hay = `${className} ${text}`.toLowerCase();

          if (
            !hay.includes("sold") &&
            !hay.includes("unavail") &&
            !hay.includes("disabled") &&
            !hay.includes("lock") &&
            !hay.includes("תפוס") &&
            !hay.includes("סגור") &&
            !hay.includes("unavailable") &&
            !hay.includes("closed")
          ) {
            return {
              available: true,
              element: el.tagName,
              className: className,
              text: el.textContent?.trim().substring(0, 50) || "",
            };
          }
        }
      }

      // Also check for "מקום פנוי" or similar text in the container
      const text = container.textContent || "";
      if (
        text.includes("פנוי") ||
        text.includes("available") ||
        text.includes("זמין") ||
        text.includes("בחר")
      ) {
        // But make sure it's not about "מקום תפוס"
        if (
          !text.includes("תפוס") &&
          !text.includes("sold out") &&
          !text.includes("אין מקומות")
        ) {
          return { available: true, reason: "text_indicator" };
        }
      }

      return { available: false };
    });

    hasAvailability = availabilityCheck.available === true;
    availabilityDetails = availabilityCheck;

  } catch (e) {
    console.log(`⚠️  Error checking availability: ${e?.message || e}`);
    if (DEBUG) console.log(`   Stack: ${e.stack}`);
    hasAvailability = false;
  }

  // Return result in the same format as before for compatibility
  const result = {
    sec: "category",
    found: true,
    avail: hasAvailability,
    details: availabilityDetails,
  };

  if (DEBUG) {
    console.log(
      `📊 Scan result: Category '${CATEGORY_NAME}' - Available: ${hasAvailability}${availabilityDetails?.available ? ` | ${JSON.stringify(availabilityDetails)}` : ""}`,
    );
  }

  return [result];
}

// ============================================================================
// Hit Handling
// ============================================================================

async function handleHit(page, results, context) {
  const availableResult = results.find((r) => r.avail === true);
  const msg = `נראית זמינות ב${CATEGORY_NAME}! פתח מהר: ${URL}`;

  process.stdout.write("\u0007"); // beep
  console.log(`🔥 ${msg}`);
  await notifyRemote(msg);

  if (HEADFUL) {
    try {
      await page.bringToFront();
    } catch {}
  }

  // Navigate to category and try to click on available element
  if (availableResult && availableResult.found) {
    try {
      console.log(`📍 מעבר ל${CATEGORY_NAME}...`);

      // Find the category and scroll to it
      const categoryTexts = CATEGORY_TEXTS;

      for (const categoryText of categoryTexts) {
        try {
          const categoryLoc = page
            .getByText(categoryText, { exact: false })
            .first();
          const count = await categoryLoc.count();

          if (count > 0) {
            await categoryLoc.scrollIntoViewIfNeeded();
            await page.waitForTimeout(500);

            // Try to find and click an available element within the category
            const clicked = await categoryLoc.evaluate((el) => {
              // Find the container
              let container = el;
              for (let i = 0; i < 10; i++) {
                if (!container) break;
                const tag = container.tagName?.toLowerCase();
                const className = container.className || "";
                if (
                  tag === "div" ||
                  tag === "section" ||
                  tag === "article" ||
                  className.includes("section") ||
                  className.includes("category") ||
                  className.includes("stand") ||
                  className.includes("tribune")
                ) {
                  break;
                }
                container = container.parentElement;
              }
              if (!container) container = el.parentElement || el;

              // Find first clickable available element
              const clickableElements = container.querySelectorAll(
                'button, a, [role="button"], [onclick]',
              );
              for (const btn of clickableElements) {
                const style = window.getComputedStyle(btn);
                if (
                  style.pointerEvents !== "none" &&
                  style.opacity > 0.5 &&
                  style.display !== "none"
                ) {
                  const className = btn.className || "";
                  const hay = className.toLowerCase();
                  if (
                    !hay.includes("sold") &&
                    !hay.includes("disabled") &&
                    !hay.includes("unavail") &&
                    !hay.includes("תפוס")
                  ) {
                    btn.click();
                    return true;
                  }
                }
              }
              return false;
            });

            if (clicked) {
              await page.waitForTimeout(1000);
              console.log(`✅ לחצתי על אלמנט זמין ב${CATEGORY_NAME}`);
            } else {
              console.log(
                `📍 הגעתי ל${CATEGORY_NAME} - לחץ ידנית על מקום זמין`,
              );
            }
            break;
          }
        } catch (e) {
          // Continue to next variation
        }
      }
    } catch (e) {
      console.log(`⚠️  שגיאה במעבר לקטגוריה: ${e?.message || e}`);
    }
  }

  if (PAUSE_ON_HIT) {
    console.log(
      "⏸️  עצרתי כאן כדי שתוכל להוסיף לעגלה / להמשיך באתר ידנית. להמשך: Ctrl+C או סגור חלון.",
    );
    await new Promise(() => {}); // wait forever
    return;
  }

  console.log("⏸️  נכנס למצב מעקב - בודק אם הזמינות עדיין קיימת...");
  await monitorAvailability(page, context);
}

async function monitorAvailability(page, context) {
  let stillAvailable = true;
  while (stillAvailable) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));

    try {
      await openEventPage(page);
      await ensureLoggedIn(page, context);

      const checkResults = await scanSections(page);
      stillAvailable = checkResults.some((r) => r.avail === true);

      if (DEBUG)
        console.log(
          `${stillAvailable ? "✅ הזמינות עדיין קיימת" : "❌ הזמינות נעלמה - חוזר לבדיקה רגילה"} | ${new Date().toLocaleTimeString("he-IL")}`,
        );
    } catch (e) {
      console.log(`⚠️  שגיאה במעקב: ${e?.message || e}`);
    }
  }
}

// ============================================================================
// Error Handling & Backoff
// ============================================================================

let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 3;
const BACKOFF_DELAY = 60_000;

async function handleError(error, currentInterval) {
  consecutiveErrors++;
  console.log(
    `Error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${error?.message || error}`,
  );

  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    console.log(
      `⚠️  ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Backing off for ${BACKOFF_DELAY / 1000} seconds...`,
    );
    await new Promise((r) => setTimeout(r, BACKOFF_DELAY));
    consecutiveErrors = 0;
    return BACKOFF_DELAY;
  }

  return currentInterval;
}

// ============================================================================
// Main Loop
// ============================================================================

(async () => {
  const { browser, context } = await createBrowserAndContext();
  const page = await context.newPage();
  await applyStealth(page);

  let availabilityStreak = 0;
  let isLoggedIn = false;
  let currentInterval = INTERVAL_MS;

  console.log(`🚀 Starting monitor for category: ${CATEGORY_NAME}`);
  console.log(`📅 Checking every ${INTERVAL_MS / 1000} seconds`);
  console.log(`🌐 URL: ${URL}`);

  // Test Telegram connection
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    console.log(`📱 Testing Telegram connection...`);
    await testTelegram();
  } else {
    console.log(
      `⚠️  Telegram not configured (TELEGRAM_TOKEN or TELEGRAM_CHAT_ID missing)`,
    );
  }



  while (true) {
    try {
      if (!isLoggedIn && LOGIN_USERNAME && LOGIN_PASSWORD) {
        isLoggedIn = await ensureLoggedIn(page, context);
        if (isLoggedIn) await saveStorageState(context);
        else if (HEADFUL) {
          console.log("⚠️  התחברות נכשלה - נסה להתחבר ידנית בחלון הדפדפן");
          await new Promise((r) => setTimeout(r, 10_000));
        }
      }

      await openEventPage(page);

      const needsLogin =
        (await page.locator('input[type="password"]').count()) > 0;
      if (needsLogin && LOGIN_USERNAME && LOGIN_PASSWORD) {
        console.log("🔐 נראה שנדרשת התחברות מחדש...");
        isLoggedIn = await performLogin(page);
        if (isLoggedIn) {
          await saveStorageState(context);
          await openEventPage(page);
        }
      }

      const results = await scanSections(page);
      const anyAvail = results.some((r) => r.avail === true);

      if (anyAvail) {
        availabilityStreak += 1;
      } else {
        availabilityStreak = 0;
      }

      if (availabilityStreak === 1)
         {        await handleHit(page, results, context);
      } else if (!anyAvail) {
        if (DEBUG)
          console.log(
            `Checked: anyAvail=${anyAvail} | ${new Date().toLocaleTimeString("he-IL")}`,
          );
        consecutiveErrors = 0;
        currentInterval = INTERVAL_MS;
      }
    } catch (e) {
            availabilityStreak = 0;
      currentInterval = await handleError(e, currentInterval);
    }

    await new Promise((r) => setTimeout(r, currentInterval));
  }
})();
