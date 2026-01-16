// Load environment variables from .env file
require('dotenv').config();

// watch-mhaifa.js - Refactored & Improved
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");



// ============================================================================
// Configuration from Environment Variables
// ============================================================================

const DEBUG = process.env.DEBUG === "1";
const HEADFUL = process.env.HEADFUL === "1";
const PAUSE_ON_HIT = process.env.PAUSE_ON_HIT !== "0"; // default: true

// Event URL and sections
const URL = process.env.URL || "https://tickets.mhaifafc.com/Stadium/Index?eventId=5065";
const SECTIONS_ENV = process.env.SECTIONS;
const SECTIONS = SECTIONS_ENV 
  ? SECTIONS_ENV.split(",").map(s => s.trim())
  : Array.from({ length: 12 }, (_, i) => String(201 + i)); // 201..212 default
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 10_000);

// Notifications
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";
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

// ============================================================================
// Node.js Version Check & Fetch Setup
// ============================================================================

function checkNodeVersion() {
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split(".")[0]);
  
  if (major < 18) {
    console.log("⚠️  Node.js < 18 detected. Installing node-fetch...");
    try {
      require("node-fetch");
    } catch (e) {
      console.error("❌ node-fetch is required for Node < 18. Install it: npm install node-fetch");
      process.exit(1);
    }
  } else {
    // Node >= 18 has global fetch
    if (typeof fetch === "undefined") {
      console.error("❌ fetch is not available. Please use Node.js >= 18 or install node-fetch");
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
          "Title": "MHFC Tickets",
          "Priority": "5",
          "Tags": "ticket,alert",
          "Click": URL,
        },
        body: message,
      }).catch((e) => DEBUG && console.log("ntfy notify failed:", e?.message || e))
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
              title: "כרטיסים זמינים!",
              description: message,
              color: 0xff0000,
              url: URL,
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      }).catch((e) => DEBUG && console.log("webhook notify failed:", e?.message || e))
    );
  }

  await Promise.all(tasks);
}

// ============================================================================
// Browser & Context Setup
// ============================================================================

async function createBrowserAndContext() {
  const browser = await chromium.launch({ 
    headless: !HEADFUL,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ]
  });
  
  // Load storage state if exists
  const storageState = fs.existsSync(STORAGE_STATE_PATH) 
    ? JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf8'))
    : undefined;
  
  const context = await browser.newContext({
    viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    permissions: ['geolocation'],
    storageState, // Load saved session if exists
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    },
  });

  return { browser, context };
}

function applyStealth(page) {
  return page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {}
    };
    
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    
    Object.defineProperty(navigator, 'languages', {
      get: () => ['he-IL', 'he', 'en-US', 'en'],
    });
    
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
    
    Object.defineProperty(navigator, 'platform', {
      get: () => 'Win32',
    });
    
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
    });
    
    Object.defineProperty(navigator, 'deviceMemory', {
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
    if ((await field.count()) > 0) {
      return field;
    }
  }

  // FIXED: Use for loop instead of findIndex(async)
  const allInputs = await page.locator('input').all();
  for (let i = 0; i < allInputs.length; i++) {
    const inp = allInputs[i];
    const type = await inp.getAttribute('type');
    if (type === 'password' && i > 0) {
      return page.locator('input').nth(i - 1);
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
    // Only go to login page if not already there
    if (LOGIN_URL && !skipGoto) {
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));
      await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(2000);
    }

    const passwordField = page.locator('input[type="password"]').first();
    const passwordCount = await passwordField.count();
    
    if (DEBUG) console.log(`   נמצאו ${passwordCount} שדות סיסמה`);
    
    if (passwordCount === 0) {
      if (DEBUG) console.log("⚠️  לא נמצא שדה סיסמה - כנראה כבר מחובר");
      return false;
    }

    const usernameField = await findUsernameField(page);

    if (!usernameField || (await usernameField.count()) === 0) {
      console.log("❌ לא נמצא שדה שם משתמש");
      if (DEBUG) {
        const currentUrl = await page.url();
        console.log(`   URL נוכחי: ${currentUrl}`);
        const allInputs = await page.locator('input').count();
        console.log(`   סך הכל ${allInputs} שדות input בדף`);
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
      'form button',
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
        if (DEBUG) console.log(`   נכשל ב-selector ${selector}: ${e?.message || e}`);
      }
    }

    if (!submitted) {
      if (DEBUG) console.log("   לא נמצא כפתור - מנסה Enter");
      await passwordField.press('Enter');
    }

    await page.waitForTimeout(3000);
    
    const currentUrl = await page.url();
    const isStillOnLoginPage = currentUrl.includes('auth.mhaifafc.com') || currentUrl.includes('/login');
    const stillHasPassword = (await page.locator('input[type="password"]').count()) > 0;
    const hasError = await page.locator('text=/שגיאה|error|נכשל/i').count() > 0;
    
    if (isStillOnLoginPage && stillHasPassword && !hasError) {
      await page.waitForTimeout(2000);
      const stillHasPassword2 = (await page.locator('input[type="password"]').count()) > 0;
      const currentUrl2 = await page.url();
      const isStillOnLoginPage2 = currentUrl2.includes('auth.mhaifafc.com') || currentUrl2.includes('/login');
      
      if (isStillOnLoginPage2 && stillHasPassword2) {
        console.log("⚠️  נראה שההתחברות נכשלה");
        return false;
      }
    }
    
    if (hasError) {
      console.log("⚠️  נראה שיש הודעת שגיאה בדף");
      return false;
    }

    console.log("✅ התחברות הצליחה!");
    return true;
  } catch (e) {
    console.log(`❌ שגיאה בהתחברות: ${e?.message || e}`);
    return false;
  }
}

async function ensureLoggedIn(page, context) {
  if (!LOGIN_USERNAME || !LOGIN_PASSWORD) {
    return true; // No login needed
  }

  // Go directly to login page to check/login
  try {
    await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(2000);
  } catch (e) {
    console.log(`⚠️  שגיאה בטעינת דף התחברות: ${e?.message || e}`);
  }

  const hasPasswordField = (await page.locator('input[type="password"]').count()) > 0;
  if (!hasPasswordField) {
    console.log("✅ נראה שכבר מחובר (אין שדה סיסמה)");
    return true; // Already logged in
  }

  console.log("🔐 מנסה להתחבר...");
  if (DEBUG) {
    console.log(`   Username: ${LOGIN_USERNAME}`);
    console.log(`   Login URL: ${LOGIN_URL}`);
  }
  const success = await performLogin(page, true); // skipGoto = true because we already navigated
  if (success) {
    await saveStorageState(context);
    console.log("✅ התחברות הושלמה בהצלחה!");
  } else {
    console.log("❌ התחברות נכשלה");
  }
  return success;
}

// ============================================================================
// Page Loading & Interaction
// ============================================================================

async function waitForMapReady(page) {
  // Try to wait for map elements instead of fixed timeout
  const mapSelectors = [
    'canvas',
    'svg',
    '[class*="map"]',
    '[id*="map"]',
    '[class*="stadium"]',
    '[id*="stadium"]',
    'iframe',
  ];

  try {
    await Promise.race([
      Promise.all(mapSelectors.map(sel => 
        page.waitForSelector(sel, { timeout: 5000 }).catch(() => null)
      )),
      new Promise(resolve => setTimeout(resolve, 3000)) // Fallback timeout
    ]);
  } catch (e) {
    // Continue anyway
  }
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
  await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
  await page.goto(URL, { waitUntil: "networkidle", timeout: 60_000 });
  await interactWithPage(page);
  await waitForMapReady(page);
  
  try {
    await page.mouse.click(400, 300);
    await page.waitForTimeout(1000);
  } catch (e) {
    // Continue
  }
}

// ============================================================================
// Availability Detection
// ============================================================================

function looksAvailable(meta) {
  const hay = `${meta.className} ${meta.ariaDisabled} ${meta.disabled} ${meta.style}`.toLowerCase();

  if (hay.includes("sold") || hay.includes("unavail") || hay.includes("disabled") || hay.includes("lock")) {
    return false;
  }
  if (meta.ariaDisabled === "true" || meta.disabled === true) {
    return false;
  }

  if (hay.includes("avail") || hay.includes("select") || hay.includes("enabled")) {
    return true;
  }

  return null; // Unknown
}

// Selectors for success indicators after clicking a section
const SUCCESS_INDICATORS = [
  'button:has-text("הוסף לעגלה")',
  'button:has-text("המשך")',
  'button:has-text("Continue")',
  'input[type="number"]', // Quantity selector
  '[class*="quantity"]',
  '[class*="seat"]',
  '[class*="modal"]',
  '[class*="panel"]',
  '[id*="modal"]',
  '[id*="panel"]',
];

async function confirmHitByClick(page, section) {
  if (!HEADFUL) {
    // In headless mode, we can't safely click without seeing the result
    return false;
  }

  try {
    const sectionElement = page.getByText(section, { exact: true }).first();
    const count = await sectionElement.count();
    
    if (count === 0) {
      return false;
    }

    await sectionElement.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    // Click the section
    await sectionElement.evaluate((el) => {
      let current = el;
      for (let i = 0; i < 5; i++) {
        if (!current) break;
        const tag = current.tagName?.toLowerCase();
        const style = window.getComputedStyle(current);
        const cursor = style.cursor;
        const pointerEvents = style.pointerEvents;
        
        if (tag === 'button' || tag === 'a' || 
            cursor === 'pointer' || 
            (pointerEvents !== 'none' && current.onclick)) {
          current.click();
          return;
        }
        current = current.parentElement;
      }
      el.click();
    });

    await page.waitForTimeout(1500);

    // Check for success indicators
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
      } catch (e) {
        // Continue checking other selectors
      }
    }

    return false;
  } catch (e) {
    if (DEBUG) console.log(`⚠️  Error confirming hit: ${e?.message || e}`);
    return false;
  }
}

async function scanSections(page) {
  const results = [];
  let foundCount = 0;
  let notFoundCount = 0;
  let nullCount = 0;
  let availableCount = 0;

  for (const sec of SECTIONS) {
    const loc = page.getByText(sec, { exact: true }).first();
    const count = await loc.count();
    
    if (count === 0) {
      results.push({ sec, found: false, avail: false });
      notFoundCount++;
      continue;
    }

    foundCount++;

    const meta = await loc.evaluate((el) => {
      const parent = el.closest("[class], [aria-disabled], [disabled]") || el;
      const cs = window.getComputedStyle(parent);
      return {
        text: el.textContent?.trim() || "",
        className: parent.className || "",
        ariaDisabled: parent.getAttribute("aria-disabled"),
        disabled: parent.hasAttribute("disabled"),
        style: `display:${cs.display}; visibility:${cs.visibility}; opacity:${cs.opacity}; pointer-events:${cs.pointerEvents}`,
      };
    });

    let avail = looksAvailable(meta);
    
    // If uncertain, try clicking to confirm (only in HEADFUL mode)
    if (avail === null && HEADFUL) {
      const confirmed = await confirmHitByClick(page, sec);
      if (confirmed) {
        avail = true;
      }
    }

    if (avail === null) {
      nullCount++;
    } else if (avail === true) {
      availableCount++;
    }

    results.push({ sec, found: true, avail, meta });
  }

  // Warning if most sections not found
  if (notFoundCount > SECTIONS.length * 0.7) {
    console.log(`⚠️  WARNING: ${notFoundCount}/${SECTIONS.length} sections NOT FOUND. Map may not be loaded or blocked.`);
  }

  if (DEBUG) {
    console.log(`📊 Scan results: Found=${foundCount}, Not Found=${notFoundCount}, Null=${nullCount}, Available=${availableCount}`);
    console.log("---- DEBUG SNAPSHOT ----");
    for (const r of results) {
      if (!r.found) {
        console.log(`${r.sec}: NOT FOUND`);
        continue;
      }
      console.log(`${r.sec}: avail=${r.avail} class="${r.meta.className}" aria-disabled=${r.meta.ariaDisabled}`);
    }
    console.log("------------------------");
  }

  return results;
}

// ============================================================================
// Hit Handling
// ============================================================================

async function handleHit(page, results, context) {
  const availableSection = results.find((r) => r.avail === true);
  const msg = availableSection 
    ? `נראית זמינות בבלוק ${availableSection.sec}! פתח מהר: ${URL}`
    : `נראית זמינות ב-${SECTIONS[0]}–${SECTIONS[SECTIONS.length - 1]}! פתח מהר: ${URL}`;
  
  process.stdout.write("\u0007"); // beep
  console.log(`🔥 ${msg}`);
  await notifyRemote(msg);

  if (HEADFUL) {
    try {
      await page.bringToFront();
    } catch {}
  }

  // Navigate to section and click
  if (availableSection && availableSection.found) {
    try {
      console.log(`📍 מעבר לבלוק ${availableSection.sec}...`);
      const sectionElement = page.getByText(availableSection.sec, { exact: true }).first();
      const elementCount = await sectionElement.count();
      
      if (elementCount > 0) {
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
            
            if (tag === 'button' || tag === 'a' || 
                cursor === 'pointer' || 
                (pointerEvents !== 'none' && current.onclick)) {
              current.click();
              return;
            }
            current = current.parentElement;
          }
          el.click();
        });
        
        await page.waitForTimeout(1000);
        console.log(`✅ לחצתי על בלוק ${availableSection.sec}`);
      }
    } catch (e) {
      console.log(`⚠️  שגיאה במעבר לבלוק: ${e?.message || e}`);
    }
  }

  // FIXED: PAUSE_ON_HIT logic
  if (PAUSE_ON_HIT) {
    console.log("⏸️  עצרתי כאן כדי שתוכל להוסיף לעגלה / להמשיך באתר ידנית. להמשך: Ctrl+C או סגור חלון.");
    await new Promise(() => {}); // Wait forever
    return; // Don't enter monitor mode
  }

  // If PAUSE_ON_HIT=false, enter monitor mode
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
      
      if (stillAvailable) {
        console.log(`✅ הזמינות עדיין קיימת | ${new Date().toLocaleTimeString("he-IL")}`);
      } else {
        console.log(`❌ הזמינות נעלמה - חוזר לבדיקה רגילה | ${new Date().toLocaleTimeString("he-IL")}`);
      }
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
const BACKOFF_DELAY = 60_000; // 60 seconds

async function handleError(error, currentInterval) {
  consecutiveErrors++;
  console.log(`Error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${error?.message || error}`);

  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    console.log(`⚠️  ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Backing off for ${BACKOFF_DELAY / 1000} seconds...`);
    await new Promise((r) => setTimeout(r, BACKOFF_DELAY));
    consecutiveErrors = 0; // Reset after backoff
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

  let lastAnyAvailable = false;
  let isLoggedIn = false;
  let currentInterval = INTERVAL_MS;

  console.log(`🚀 Starting monitor for sections: ${SECTIONS.join(", ")}`);
  console.log(`📅 Checking every ${INTERVAL_MS / 1000} seconds`);
  console.log(`🌐 URL: ${URL}`);

  while (true) {
    try {
      // Ensure logged in
      if (!isLoggedIn && LOGIN_USERNAME && LOGIN_PASSWORD) {
        isLoggedIn = await ensureLoggedIn(page, context);
        if (isLoggedIn) {
          await saveStorageState(context);
        } else if (HEADFUL) {
          console.log("⚠️  התחברות נכשלה - נסה להתחבר ידנית בחלון הדפדפן");
          await new Promise((r) => setTimeout(r, 10000));
        }
      }

      // Open event page
      await openEventPage(page);

      // Check if re-login needed
      const needsLogin = (await page.locator('input[type="password"]').count()) > 0;
      if (needsLogin && LOGIN_USERNAME && LOGIN_PASSWORD) {
        console.log("🔐 נראה שנדרשת התחברות מחדש...");
        isLoggedIn = await performLogin(page);
        if (isLoggedIn) {
          await saveStorageState(context);
          await openEventPage(page);
        }
      }

      // Scan sections
      const results = await scanSections(page);
      const anyAvail = results.some((r) => r.avail === true);

      // Handle hit
      if (anyAvail && !lastAnyAvailable) {
        await handleHit(page, results, context);
        lastAnyAvailable = true;
      } else if (!anyAvail) {
        console.log(`Checked: anyAvail=${anyAvail} | ${new Date().toLocaleTimeString("he-IL")}`);
        lastAnyAvailable = false;
        consecutiveErrors = 0; // Reset on success
        currentInterval = INTERVAL_MS; // Reset interval
      }

    } catch (e) {
      currentInterval = await handleError(e, currentInterval);
    }

    await new Promise((r) => setTimeout(r, currentInterval));
  }
})();
