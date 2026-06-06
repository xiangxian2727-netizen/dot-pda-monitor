/**
 * monitor.js — DOT PDA Cannington Availability Checker
 *
 * Runs headlessly (in GitHub Actions or locally) to check if the
 * Cannington test centre has any available PDA (Practical Driving
 * Assessment) slots for a Class C (Manual) licence.
 *
 * Designed to work with browser state captured by login.js.
 *
 * Usage (local):
 *   DOT_COOKIES=$(cat cookies.json | base64) \
 *   TELEGRAM_BOT_TOKEN=xxx \
 *   TELEGRAM_CHAT_ID=xxx \
 *   node monitor.js
 */

const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────
const PDA_ENTRY_URL =
  'https://online.transport.wa.gov.au/pdabooking/manage/';

const DOT_LOGIN_REDIRECT =
  'https://www.transport.wa.gov.au/login-(to-dotdirect)';

const CANNINGTON = 'Cannington';
const LICENCE_CLASS = 'C'; // Manual

// Page expiry / session invalid indicators
const SESSION_EXPIRED_MARKERS = [
  'Page Expired',
  'page has expired',
  'Return to home page',
  'Session Expired',
];

const LOGIN_PAGE_MARKERS = [
  'DoTDirect',
  'loginForm:userId',
  'loginForm:password',
];

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

// ── Helpers ─────────────────────────────────────────────────────────

function log(message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}`;
  console.log(line);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Send a message via Telegram Bot API.
 * Returns the response body as a string.
 */
function sendTelegram(token, chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(data);
          } else {
            reject(new Error(`Telegram API ${res.statusCode}: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Telegram API timeout'));
    });

    req.write(body);
    req.end();
  });
}

// ── Session check ───────────────────────────────────────────────────

/**
 * Check if the current page shows that the session has expired.
 */
async function isSessionExpired(page) {
  try {
    const bodyText = await page.evaluate(() => document.body.innerText);
    return SESSION_EXPIRED_MARKERS.some((marker) =>
      bodyText.toLowerCase().includes(marker.toLowerCase())
    );
  } catch (_) {
    return true; // Assume expired if we can't check
  }
}

/**
 * Check if the current page is showing the login page.
 */
async function isLoginPage(page) {
  try {
    const html = await page.content();
    return LOGIN_PAGE_MARKERS.some((marker) => html.includes(marker));
  } catch (_) {
    return true;
  }
}

// ── Page analysis helpers ───────────────────────────────────────────

/**
 * Extract all visible text from the page and log it.
 * Useful for debugging when running headlessly.
 */
async function logPageSummary(page) {
  try {
    const title = await page.title();
    const url = page.url();
    log(`Page title: "${title}"`);
    log(`Page URL: ${url}`);

    // Extract main content text (first 500 chars)
    const bodyText = await page.evaluate(() => {
      // Try to get main content area
      const main = document.querySelector(
        'main, #content, .content, [role="main"]'
      );
      const el = main || document.body;
      return el.innerText.substring(0, 500);
    });
    log(`Page text (first 500 chars): ${bodyText.replace(/\s+/g, ' ')}`);
  } catch (err) {
    log(`Could not read page: ${err.message}`);
  }
}

/**
 * Take a timestamped screenshot for debugging.
 */
async function takeDebugScreenshot(page, name) {
  try {
    ensureDir(SCREENSHOTS_DIR);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(SCREENSHOTS_DIR, `${name}-${ts}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log(`Screenshot saved: ${file}`);
    return file;
  } catch (err) {
    log(`Screenshot failed: ${err.message}`);
    return null;
  }
}

// ── Availability extraction ─────────────────────────────────────────

/**
 * Try to extract available time slots from the page.
 *
 * Since we don't know the exact page structure yet, this function
 * makes reasonable guesses based on common DOT / govt booking patterns.
 *
 * Returns: { found: boolean, slots: string[], rawText: string }
 */
async function extractAvailability(page) {
  const result = { found: false, slots: [], rawText: '' };

  try {
    const bodyText = await page.evaluate(() => document.body.innerText);
    result.rawText = bodyText.substring(0, 2000);

    // ── Pattern 1: Look for date/time patterns (e.g. "Monday 20 June 2026") ──
    const datePattern =
      /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/gi;
    const dateMatches = bodyText.match(datePattern) || [];

    // ── Pattern 2: Look for time patterns (e.g. "10:15 AM", "2:30 PM") ──
    const timePattern = /\b\d{1,2}:\d{2}\s*(AM|PM|am|pm)\b/g;
    const timeMatches = bodyText.match(timePattern) || [];

    // ── Pattern 3: Explicit "available" or "no available" indicators ──
    const noAvailabilityPattern =
      /no (available|appointment|slot|booking|vacanc)/i;
    const hasAvailabilityPattern =
      /(available|select|choose|book)\s+(appointment|slot|time|date|session)/i;

    const hasNoAvailability = noAvailabilityPattern.test(bodyText);
    const hasAvailability = hasAvailabilityPattern.test(bodyText);

    // ── Pattern 4: Check for Cannington mention ──
    const canningtonMention = bodyText
      .toLowerCase()
      .includes(CANNINGTON.toLowerCase());

    // ── Pattern 5: Look for table rows with booking times ──
    const tableSlots = await page.evaluate(() => {
      const slots = [];
      // Look for table rows that might contain booking slots
      const rows = document.querySelectorAll('tr');
      for (const row of rows) {
        const text = row.innerText.trim();
        if (
          text &&
          /\d{1,2}:\d{2}/.test(text) &&
          text.length < 200
        ) {
          slots.push(text);
        }
      }
      return slots;
    });

    // ── Pattern 6: Radio buttons / checkboxes for time selection ──
    const selectableOptions = await page.evaluate(() => {
      const options = [];
      const labels = document.querySelectorAll(
        'label:has(input[type="radio"]), label:has(input[type="checkbox"])'
      );
      for (const label of labels) {
        const text = label.innerText.trim();
        if (text && text.length > 3 && text.length < 200) {
          options.push(text);
        }
      }
      return options;
    });

    // ── Assemble findings ──
    if (dateMatches.length > 0 || timeMatches.length > 0 || tableSlots.length > 0 || selectableOptions.length > 0) {
      result.found = true;

      // Combine date and time information
      if (dateMatches.length > 0) {
        result.slots.push(`Dates found: ${dateMatches.join(', ')}`);
      }
      if (timeMatches.length > 0) {
        result.slots.push(`Times found: ${timeMatches.join(', ')}`);
      }
      for (const slot of tableSlots) {
        result.slots.push(`Table row: ${slot}`);
      }
      for (const opt of selectableOptions) {
        result.slots.push(`Option: ${opt}`);
      }
    }

    // Explicit "no availability" message
    if (hasNoAvailability) {
      result.found = false;
      result.slots.push('Site indicates no available slots');
    }

    // Cannington info
    if (canningtonMention) {
      result.slots.push('(Cannington mentioned on page)');
    }
  } catch (err) {
    log(`Error extracting availability: ${err.message}`);
  }

  return result;
}

// ── Build notification message ──────────────────────────────────────

function buildTelegramMessage(availability) {
  const lines = ['<b>🎉 Cannington PDA 可能有空位！</b>', ''];

  if (availability.slots.length > 0) {
    lines.push('<b>发现以下内容：</b>');
    for (const slot of availability.slots.slice(0, 10)) {
      lines.push(`  • ${slot}`);
    }
  } else {
    lines.push('检测到页面上有可用时段的信息。');
  }

  lines.push('');
  lines.push(
    '🔗 <a href="https://online.transport.wa.gov.au/pdabooking/manage/">立即查看预约</a>'
  );
  lines.push('');
  lines.push(`📅 检测时间: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Perth' })} (Perth时间)`);

  return lines.join('\n');
}

// ── Main monitor logic ──────────────────────────────────────────────

async function monitor() {
  log('═══ DOT PDA Monitor started ═══');

  // ── Validate environment ──
  const dotCookiesB64 = process.env.DOT_COOKIES;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;

  if (!dotCookiesB64) {
    log('ERROR: DOT_COOKIES environment variable not set');
    log('Run login.js first to generate cookies, then set DOT_COOKIES.');
    process.exit(1);
  }

  if (!telegramToken || !telegramChatId) {
    log('WARNING: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    log('Notifications will not be sent.');
  }

  // ── Decode cookies ──
  let browserState;
  try {
    const json = Buffer.from(dotCookiesB64, 'base64').toString('utf-8');
    browserState = JSON.parse(json);
    log(`Cookies loaded (saved at: ${browserState.savedAt || 'unknown'})`);
  } catch (err) {
    log(`ERROR: Failed to parse DOT_COOKIES: ${err.message}`);
    process.exit(1);
  }

  // ── Launch headless browser ──
  log('Launching headless browser...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent: browserState.userAgent ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  // ── Restore cookies ──
  if (browserState.cookies && browserState.cookies.length > 0) {
    await context.addCookies(browserState.cookies);
    log(`Restored ${browserState.cookies.length} cookies`);
  } else {
    log('WARNING: No cookies found in browser state');
  }

  const page = await context.newPage();

  // Restore localStorage if available
  if (browserState.localStorage && Object.keys(browserState.localStorage).length > 0) {
    try {
      await page.goto(PDA_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.evaluate((data) => {
        for (const [key, value] of Object.entries(data)) {
          window.localStorage.setItem(key, value);
        }
      }, browserState.localStorage);
      log('Restored localStorage');
    } catch (err) {
      log(`Could not restore localStorage: ${err.message}`);
    }
  }

  try {
    // ── Navigate to PDA booking ──
    log(`Navigating to: ${PDA_ENTRY_URL}`);
    await page.goto(PDA_ENTRY_URL, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Wait a bit for any redirects / JS to settle
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    log(`Landed on: ${currentUrl}`);

    // ── Check session status ──
    const expired = await isSessionExpired(page);
    const onLoginPage = await isLoginPage(page);

    if (expired) {
      log('Session expired — "Page Expired" detected');
      await takeDebugScreenshot(page, 'session-expired');

      if (telegramToken && telegramChatId) {
        try {
          await sendTelegram(
            telegramToken,
            telegramChatId,
            '<b>⚠️ DOT Session 已过期</b>\n\n' +
              '请在 Mac 上重新运行 login.js 来更新 cookies，\n' +
              '然后将新的 cookies 上传到 GitHub Secrets。\n\n' +
              '命令：<code>node login.js</code>\n' +
              '然后：<code>gh secret set DOT_COOKIES --body "$(cat cookies.json | base64)"</code>'
          );
          log('Sent session-expired notification via Telegram');
        } catch (err) {
          log(`Failed to send Telegram: ${err.message}`);
        }
      }
    } else if (onLoginPage) {
      log('Redirected to login page — session is invalid');
      await takeDebugScreenshot(page, 'redirected-to-login');

      if (telegramToken && telegramChatId) {
        try {
          await sendTelegram(
            telegramToken,
            telegramChatId,
            '<b>⚠️ DOT Session 已过期（重定向到登录页）</b>\n\n' +
              '请重新运行 login.js 更新 cookies，然后更新 GitHub Secrets。'
          );
          log('Sent login-redirect notification via Telegram');
        } catch (err) {
          log(`Failed to send Telegram: ${err.message}`);
        }
      }
    } else {
      // Session is valid — analyze the page
      log('Session appears valid');
      await logPageSummary(page);

      // Take a screenshot for debugging
      await takeDebugScreenshot(page, 'booking-page');

      // ── Try to find Cannington availability ──
      const availability = await extractAvailability(page);

      log(`Availability check: found=${availability.found}, slots=${availability.slots.length}`);

      if (availability.found) {
        log('POTENTIAL SLOTS FOUND!');
        log(JSON.stringify(availability.slots, null, 2));

        if (telegramToken && telegramChatId) {
          try {
            const message = buildTelegramMessage(availability);
            await sendTelegram(telegramToken, telegramChatId, message);
            log('Sent availability notification via Telegram');
          } catch (err) {
            log(`Failed to send Telegram: ${err.message}`);
          }
        }
      } else {
        log('No available slots detected for Cannington');
      }
    }
  } catch (err) {
    log(`Monitor error: ${err.message}`);
    await takeDebugScreenshot(page, 'error');

    if (telegramToken && telegramChatId) {
      try {
        await sendTelegram(
          telegramToken,
          telegramChatId,
          `<b>❌ DOT Monitor 运行出错</b>\n\n<code>${err.message}</code>`
        );
      } catch (_) {
        // Don't fail if Telegram notification also fails
      }
    }

    throw err; // Re-throw to fail the GitHub Actions job
  } finally {
    await browser.close();
  }

  log('═══ Monitor complete ═══');
}

// ── Run ─────────────────────────────────────────────────────────────

monitor().catch((err) => {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
});
