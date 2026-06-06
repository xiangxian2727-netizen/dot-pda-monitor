/**
 * monitor.js — DOT PDA Cannington Availability Checker
 *
 * Runs headlessly (in GitHub Actions or locally) to check if the
 * Cannington test centre has any available PDA (Practical Driving
 * Assessment) slots for a Class C (Manual) licence.
 *
 * Navigates through the Wicket-based PDA booking page, selects
 * Cannington, sets a date range, and parses the results.
 *
 * Usage (local):
 *   DOT_COOKIES=$(cat cookies.json | base64) \
 *   TELEGRAM_BOT_TOKEN=xxx \
 *   TELEGRAM_CHAT_ID=xxx \
 *   node monitor.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────
const PDA_BOOKING_URL =
  'https://online.transport.wa.gov.au/pdabooking/manage/wicket/page?1';

const CANNINGTON_SITE_CODE = 'CAN';
const CANNINGTON_LABEL = 'Cannington';

// Page expiry / session invalid indicators
const SESSION_EXPIRED_MARKERS = [
  'Page Expired',
  'page has expired',
  'Return to home page',
  'Session Expired',
];

// Login page URLs — we only flag as "login page" if we land on these URLs
const LOGIN_PAGE_URLS = [
  '/tso/selfservice/public/login',
  '/login-(to-dotdirect)',
  '/dotdirect/',
];

// JSF login form markers (must match BOTH to be a real login page)
const LOGIN_FORM_MARKERS = [
  'loginForm:userId',
  'loginForm:password',
];

// Known error messages that mean "no slots available"
const NO_SLOTS_MARKERS = [
  'no bookings available for the date requested',
  'no bookings available',
  'no available bookings',
  'no appointments available',
  'No times available',
  'There are no available',
  'There is no available',
];

// Known success indicators — text that appears when slots ARE available
const SLOTS_AVAILABLE_MARKERS = [
  'Available times',
  'available times',
  'Select a time',
  'select a time',
  'Choose a time',
  'Please select a booking time',
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
 * Format a date as dd/mm/yyyy in Australia/Perth timezone.
 * DOT servers run on Perth time — dates must be Perth-local.
 */
function formatDateAU(date) {
  // Use Intl.DateTimeFormat with Perth timezone to get correct day/month/year
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Perth',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(date);

  const day = parts.find((p) => p.type === 'day').value;
  const month = parts.find((p) => p.type === 'month').value;
  const year = parts.find((p) => p.type === 'year').value;

  return `${day}/${month}/${year}`;
}

/**
 * Check if this run should send a daily heartbeat notification.
 * Returns true once per day at ~9:00 AM Perth time (1:00 AM UTC).
 * The cron fires every 10 minutes, so we narrow to the :00 slot.
 */
function shouldSendHeartbeat() {
  const now = new Date();
  const perthHour = parseInt(
    new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Perth',
      hour: '2-digit',
      hour12: false,
    }).format(now),
    10
  );
  const perthMinute = parseInt(
    new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Perth',
      minute: '2-digit',
    }).format(now),
    10
  );
  // Fire only in the 9:00–9:09 AM Perth window (first cron tick)
  return perthHour === 9 && perthMinute < 10;
}

/**
 * Send a message via Telegram Bot API.
 * Uses Node.js built-in fetch with retry support.
 */
async function sendTelegram(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) {
        log(`Telegram retry attempt ${attempt + 1}...`);
        await new Promise((r) => setTimeout(r, 3000));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const data = await response.text();
      if (response.status === 200) {
        return data;
      }
      lastError = new Error(`Telegram API ${response.status}: ${data}`);
    } catch (err) {
      lastError = err;
      log(`Telegram attempt ${attempt + 1} failed: ${err.message}`);
    }
  }

  throw lastError || new Error('Telegram send failed after retries');
}

// ── Session check helpers ───────────────────────────────────────────

async function isSessionExpired(page) {
  try {
    const bodyText = await page.evaluate(() => document.body.innerText);
    return SESSION_EXPIRED_MARKERS.some((marker) =>
      bodyText.toLowerCase().includes(marker.toLowerCase())
    );
  } catch (_) {
    return true;
  }
}

async function isLoginPage(page) {
  try {
    const url = page.url();
    const onLoginUrl = LOGIN_PAGE_URLS.some((path) => url.includes(path));
    if (!onLoginUrl) {
      return false;
    }
    const html = await page.content();
    return LOGIN_FORM_MARKERS.every((marker) => html.includes(marker));
  } catch (_) {
    return false;
  }
}

// ── Page helpers ────────────────────────────────────────────────────

async function logPageSummary(page) {
  try {
    const title = await page.title();
    const url = page.url();
    log(`Page title: "${title}"`);
    log(`Page URL: ${url}`);

    // Target DOT form containers specifically — .container-center
    // only gets the outer header wrapper
    const bodyText = await page.evaluate(() => {
      // Try DOT-specific containers first, then fall back to body
      const form = document.querySelector(
        '.licensing-big-form, #requestForm, form, [id*="searchBooking"]'
      );
      const el = form || document.body;
      return el.innerText
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .substring(0, 800);
    });
    log(`Page text: ${bodyText}`);
  } catch (err) {
    log(`Could not read page: ${err.message}`);
  }
}

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

// ── Wicket form interaction ─────────────────────────────────────────

/**
 * Wait for Wicket AJAX to complete.
 * Wicket adds/removes indicator elements during AJAX calls.
 */
async function waitForWicketAjax(page, timeoutMs = 10000) {
  try {
    // Wait for any visible AJAX indicator to disappear
    await page.waitForFunction(() => {
      const indicators = document.querySelectorAll('.wicket-ajax-indicator');
      for (const el of indicators) {
        if (el.style.display !== 'none' && el.offsetParent !== null) {
          return false;
        }
      }
      return true;
    }, { timeout: timeoutMs });
    // Small extra wait for DOM updates to settle
    await page.waitForTimeout(500);
  } catch (_) {
    // Timeout is OK — the AJAX might have completed before we checked
    log('  (AJAX wait timeout or already complete)');
  }
}

/**
 * Select Metro region radio button and wait for the site list to populate.
 *
 * Wicket's attachChoiceHandlers only fires AJAX when a radio is CLICKED.
 * On page load, Metro is already checked but no AJAX fires, leaving the
 * #id2 site list empty. We force-click Metro (even if checked) to trigger
 * the AJAX that populates the site checkboxes.
 */
async function selectMetroRegion(page) {
  log('Selecting Metro region...');
  try {
    const metroRadio = page.locator('#id1-METRO');
    if (!(await metroRadio.isVisible({ timeout: 3000 }).catch(() => false))) {
      log('  Metro radio not found');
      return;
    }

    // Always click to trigger Wicket AJAX that populates site list
    await metroRadio.click();
    log('  Clicked Metro radio — waiting for site list AJAX...');
    await waitForWicketAjax(page);

    // Wait for checkboxes to actually appear in #id2
    try {
      await page.waitForFunction(() => {
        const id2 = document.getElementById('id2');
        if (!id2) return false;
        const checkboxes = id2.querySelectorAll('input[type="checkbox"]');
        return checkboxes.length > 0;
      }, { timeout: 8000 });
      log('  Site checkboxes populated');
    } catch (_) {
      log('  WARNING: Site checkboxes did not appear after region select');
      // Dump #id2 content for debugging
      try {
        const id2html = await page.evaluate(() => {
          const el = document.getElementById('id2');
          return el ? el.innerHTML.substring(0, 300) : '#id2 not found';
        });
        log(`  #id2 content: ${id2html}`);
      } catch (_) {}
    }
  } catch (err) {
    log(`  Metro selection error: ${err.message}`);
  }
}

/**
 * Check the Cannington checkbox and wait for AJAX.
 * Tries multiple selector strategies since Wicket IDs contain colons.
 * Returns true if the checkbox was found and checked.
 */
async function selectCannington(page) {
  log('Selecting Cannington site...');
  try {
    // Strategy 1: Attribute selector with exact ID
    let canningtonCheckbox = page.locator(
      `[id="id2-searchBookingContainer:siteList_${CANNINGTON_SITE_CODE}"]`
    );

    let found = await canningtonCheckbox.isVisible({ timeout: 2000 }).catch(() => false);

    // Strategy 2: Find by label text "Cannington"
    if (!found) {
      log('  Trying label-based selector...');
      // Click the label for Cannington, which should check the associated checkbox
      const canningtonLabel = page.locator('label', { hasText: CANNINGTON_LABEL });
      if (await canningtonLabel.isVisible({ timeout: 2000 }).catch(() => false)) {
        await canningtonLabel.click();
        log('  Clicked Cannington label — waiting for AJAX');
        await waitForWicketAjax(page);
        log('  Cannington selected via label');
        return true;
      }
    }

    // Strategy 3: Look for any checkbox whose value is CAN
    if (!found) {
      log('  Trying value-based selector...');
      canningtonCheckbox = page.locator(
        `input[type="checkbox"][value="${CANNINGTON_SITE_CODE}"]`
      );
      found = await canningtonCheckbox.isVisible({ timeout: 2000 }).catch(() => false);
    }

    if (!found) {
      log('  WARNING: Cannington checkbox not found by any strategy');
      return false;
    }

    const isChecked = await canningtonCheckbox.isChecked();
    if (!isChecked) {
      await canningtonCheckbox.click();
      log('  Clicked Cannington checkbox — waiting for AJAX');
      await waitForWicketAjax(page);
      log('  Cannington selected');
    } else {
      log('  Cannington already selected');
    }
    return true;
  } catch (err) {
    log(`  Cannington selection error: ${err.message}`);
    return false;
  }
}

/**
 * Enter date range: from today to today + 6 months.
 * Uses the datePicker inputs (fromDateInput / toDateInput).
 */
async function setDateRange(page) {
  log('Setting date range...');
  try {
    const now = new Date();
    // Use tomorrow as "from" date (DOT requires a future date)
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const sixMonths = new Date(tomorrow);
    sixMonths.setMonth(sixMonths.getMonth() + 6);

    const fromDateStr = formatDateAU(tomorrow);
    const toDateStr = formatDateAU(sixMonths);

    log(`  Date range: ${fromDateStr} → ${toDateStr}`);

    // Fill "from" date — use type() to simulate real typing
    // (fill() doesn't trigger Wicket's date validation properly)
    const fromInput = page.locator('#fromDateInput');
    if (await fromInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await fromInput.click();
      await fromInput.fill('');
      await page.waitForTimeout(200);
      await fromInput.type(fromDateStr, { delay: 80 });
      // Tab away to trigger onchange
      await fromInput.press('Tab');
      log('  From date entered — waiting for AJAX');
      await waitForWicketAjax(page);
    } else {
      log('  WARNING: fromDateInput not found');
    }

    // Fill "to" date
    const toInput = page.locator('#toDateInput');
    if (await toInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await toInput.click();
      await toInput.fill('');
      await page.waitForTimeout(200);
      await toInput.type(toDateStr, { delay: 80 });
      await toInput.press('Tab');
      log('  To date entered — waiting for AJAX');
      await waitForWicketAjax(page);
    } else {
      log('  WARNING: toDateInput not found');
    }
  } catch (err) {
    log(`  Date range error: ${err.message}`);
  }
}

/**
 * Click the Search button and wait for results.
 */
async function clickSearch(page) {
  log('Clicking Search...');
  try {
    const searchBtn = page.locator(
      'input[name="searchBookingContainer:search"]'
    );
    if (await searchBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await searchBtn.click();
      log('  Search clicked — waiting for results...');
      // Wait longer for search results — can take several seconds
      await waitForWicketAjax(page, 15000);
      // Additional wait for result rendering
      await page.waitForTimeout(2000);
      log('  Search complete');
    } else {
      log('  WARNING: Search button not found');
    }
  } catch (err) {
    log(`  Search click error: ${err.message}`);
  }
}

// ── Result parsing ──────────────────────────────────────────────────

/**
 * Parse the page after search to determine if slots are available.
 *
 * Known page structure:
 *   - No slots: <span class="feedbackPanelERROR">Sorry, there are no
 *     bookings available for the date requested...</span>
 *   - Slots available: a table or list of available date/time options
 *     with radio buttons to select a time
 *
 * Returns: { found: boolean, slots: string[], summary: string }
 */
async function parseResults(page) {
  const result = { found: false, slots: [], summary: '' };

  try {
    // Get the FULL body text — DOT page has deep nesting
    const bodyText = await page.evaluate(() => document.body.innerText);
    result.summary = bodyText.substring(0, 3000);

    // Log a snippet for debugging
    const compact = bodyText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n');
    log(`Body text preview: ${compact.substring(0, 400)}`);

    // ── Check for DOT-specific error CSS class ──
    const hasFeedbackError = await page.evaluate(() => {
      const errEl = document.querySelector('.feedbackPanelERROR');
      return errEl ? errEl.innerText.trim() : null;
    });
    if (hasFeedbackError) {
      log(`  → DOT error message: "${hasFeedbackError.substring(0, 200)}"`);
      if (NO_SLOTS_MARKERS.some((m) =>
        hasFeedbackError.toLowerCase().includes(m.toLowerCase())
      )) {
        log('  → Page indicates NO slots available');
        result.slots.push(`DOT: ${hasFeedbackError}`);
        return result;
      }
    }

    // ── Check for "no slots" text markers ──
    const hasNoSlotsMessage = NO_SLOTS_MARKERS.some((marker) =>
      bodyText.toLowerCase().includes(marker.toLowerCase())
    );

    if (hasNoSlotsMessage) {
      log('  → Page indicates NO slots available');
      result.slots.push('DOT reports: no bookings available for this date range');
      return result;
    }

    // ── Check for positive availability indicators ──
    const hasAvailableIndicator = SLOTS_AVAILABLE_MARKERS.some((marker) =>
      bodyText.toLowerCase().includes(marker.toLowerCase())
    );

    // ── Look for date patterns in the results ──
    const datePattern =
      /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/gi;
    const dateMatches = bodyText.match(datePattern) || [];

    // ── Look for time patterns ──
    const timePattern = /\b\d{1,2}:\d{2}\s*(AM|PM|am|pm)\b/g;
    const timeMatches = bodyText.match(timePattern) || [];

    // ── Look for radio/checkbox labels (slot selection options) ──
    const selectableOptions = await page.evaluate(() => {
      const options = [];
      // Radio button labels in the booking time selection area
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

    // ── Look for table rows with booking info ──
    const tableSlots = await page.evaluate(() => {
      const slots = [];
      const rows = document.querySelectorAll('tr');
      for (const row of rows) {
        const text = row.innerText.trim();
        if (text && /\d{1,2}:\d{2}/.test(text) && text.length < 200) {
          slots.push(text);
        }
      }
      return slots;
    });

    // ── Assemble findings ──
    if (dateMatches.length > 0) {
      result.slots.push(`Dates: ${dateMatches.join(', ')}`);
    }
    if (timeMatches.length > 0) {
      result.slots.push(`Times: ${timeMatches.join(', ')}`);
    }
    for (const slot of tableSlots) {
      result.slots.push(`Row: ${slot}`);
    }
    for (const opt of selectableOptions) {
      result.slots.push(`Option: ${opt}`);
    }

    if (hasAvailableIndicator || dateMatches.length > 0 || timeMatches.length > 0 || selectableOptions.length > 0 || tableSlots.length > 0) {
      if (dateMatches.length > 0 || selectableOptions.length > 0 || tableSlots.length > 0) {
        result.found = true;
        log('  → POTENTIAL SLOTS DETECTED!');
      } else if (hasAvailableIndicator && !hasNoSlotsMessage) {
        result.found = true;
        log('  → Availability indicators found (but no specific dates extracted)');
      }
    }

    if (!result.found) {
      log('  → No available slots detected');
    }

    // Check for Cannington mention (sanity check)
    const canningtonMentioned = bodyText
      .toLowerCase()
      .includes(CANNINGTON_LABEL.toLowerCase());
    if (canningtonMentioned) {
      result.slots.push('(Cannington is referenced on the page)');
    }
  } catch (err) {
    log(`Error parsing results: ${err.message}`);
  }

  return result;
}

// ── Build notification message ──────────────────────────────────────

function buildTelegramMessage(availability) {
  const lines = ['<b>🎉 Cannington PDA 可能有空位！</b>', ''];

  if (availability.slots.length > 0) {
    lines.push('<b>发现以下内容：</b>');
    for (const slot of availability.slots.slice(0, 15)) {
      lines.push(`  • ${slot}`);
    }
  } else {
    lines.push('检测到页面上有可用时段的信息。');
  }

  lines.push('');
  lines.push(
    '🔗 <a href="https://online.transport.wa.gov.au/pdabooking/manage/wicket/page?1">立即查看预约</a>'
  );
  lines.push('');
  const perthTime = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Perth',
  });
  lines.push(`📅 检测时间: ${perthTime} (Perth时间)`);

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

  // ── Test notification mode ──
  if (process.env.TEST_NOTIFY === 'true') {
    log('TEST_NOTIFY mode — sending test Telegram message...');
    if (telegramToken && telegramChatId) {
      try {
        // First, check what chats the bot can see (diagnostic)
        log(`Configured Chat ID: ${telegramChatId}`);
        try {
          const updatesRes = await fetch(
            `https://api.telegram.org/bot${telegramToken}/getUpdates?limit=5`
          );
          const updates = await updatesRes.json();
          if (updates.ok && updates.result.length > 0) {
            log('Recent chats the bot can see:');
            for (const u of updates.result) {
              const chat = u.message?.chat || u.channel_post?.chat || {};
              log(`  → Chat ID: ${chat.id}, Type: ${chat.type}, Name: ${chat.first_name || chat.title || 'N/A'}`);
            }
          } else {
            log('⚠️  Bot has NO recent messages — you need to send a message to your bot first!');
            log('   Open Telegram → find your bot → send /start or "hello"');
          }
        } catch (e) {
          log(`Diagnostic fetch failed: ${e.message}`);
        }

        const nowPerth = new Intl.DateTimeFormat('en-AU', {
          timeZone: 'Australia/Perth',
          dateStyle: 'full',
          timeStyle: 'short',
        }).format(new Date());
        await sendTelegram(
          telegramToken,
          telegramChatId,
          '<b>🧪 DOT PDA Monitor 测试通知</b>\n\n' +
            '✅ Telegram 通知管道正常工作！\n\n' +
            '系统状态：Cannington 考场每 10 分钟自动检查中\n' +
            '当前结果：暂无空位\n\n' +
            `📅 测试时间: ${nowPerth} (Perth)\n\n` +
            '💡 <i>每天早上 9:00 会收到一次心跳确认系统运行正常。</i>'
        );
        log('✅ Test notification sent successfully!');
      } catch (err) {
        log(`❌ Test notification failed: ${err.message}`);
        log('');
        log('故障排查：');
        log('1. 在 Telegram 中给你的 Bot 发送 /start');
        log('2. 用 @userinfobot 获取正确的 Chat ID');
        log('3. 更新 GitHub Secret: gh secret set TELEGRAM_CHAT_ID --body "你的ID"');
      }
    } else {
      log('Cannot send test — Telegram not configured');
    }
    log('═══ Test complete ═══');
    return;
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
    userAgent:
      browserState.userAgent ||
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
  if (
    browserState.localStorage &&
    Object.keys(browserState.localStorage).length > 0
  ) {
    try {
      await page.goto(PDA_BOOKING_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
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
    let notified = false; // Track if we already sent a Telegram message

    // ── Step 1: Navigate to PDA booking page ──
    log(`Navigating to: ${PDA_BOOKING_URL}`);
    await page.goto(PDA_BOOKING_URL, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Wait for Wicket page to fully initialize
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    log(`Landed on: ${currentUrl}`);

    // ── Step 2: Check session status ──
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
          notified = true;
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
          notified = true;
        } catch (err) {
          log(`Failed to send Telegram: ${err.message}`);
        }
      }
    } else {
      // ── Step 3: Session valid — interact with booking form ──
      log('Session appears valid');
      await logPageSummary(page);

      // Check if we're on a page that has the PDA booking form
      const hasBookingForm = await page.evaluate(() => {
        return (
          !!document.querySelector('#fromDateInput') ||
          !!document.querySelector('input[name="searchBookingContainer:search"]')
        );
      });

      if (hasBookingForm) {
        log('PDA booking form detected — proceeding with search');

        // Select Metro region (force-click to trigger Wicket AJAX)
        await selectMetroRegion(page);

        // Select Cannington site
        await selectCannington(page);

        // Set date range
        await setDateRange(page);

        // Click Search
        await clickSearch(page);

        // Take a screenshot after search
        await takeDebugScreenshot(page, 'search-results');

        // Log page state after search
        await logPageSummary(page);

        // ── Step 4: Parse results ──
        const availability = await parseResults(page);

        log(
          `Availability check: found=${availability.found}, slots=${availability.slots.length}`
        );

        if (availability.found) {
          log('SLOTS FOUND!');
          log(JSON.stringify(availability.slots, null, 2));

          if (telegramToken && telegramChatId) {
            try {
              const message = buildTelegramMessage(availability);
              await sendTelegram(telegramToken, telegramChatId, message);
              log('Sent availability notification via Telegram');
              notified = true;
            } catch (err) {
              log(`Failed to send Telegram: ${err.message}`);
            }
          }
        } else {
          log('No available slots for Cannington');
        }
      } else {
        // We're on a page but it doesn't have the booking form
        log('WARNING: Booking form not found on this page');
        log('This might be an intermediary page — taking screenshot for analysis');
        await takeDebugScreenshot(page, 'no-booking-form');
        await logPageSummary(page);

        // Try to click through to the booking page if we see relevant links
        const bodyText = await page.evaluate(() => document.body.innerText);
        if (
          bodyText.includes('Driving Instructor') ||
          bodyText.includes('driving instructor')
        ) {
          log('On driving instructor portal — session may not support learner booking');
          if (telegramToken && telegramChatId) {
            try {
              await sendTelegram(
                telegramToken,
                telegramChatId,
                '<b>⚠️ DOT Monitor 进入了教练页面</b>\n\n' +
                  'Session 可能没有正确保存学员入口的 cookies。\n' +
                  '请在 Mac 上重新运行 login.js 并确保通过 DoTDirect 登录。\n\n' +
                  '流程: DoTDirect → Driver\'s License → PDA Bookings → Book PDA'
              );
              notified = true;
            } catch (_) {}
          }
        }
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
        notified = true;
      } catch (_) {
        // Don't fail if Telegram notification also fails
      }
    }

    throw err;
  } finally {
    await browser.close();
  }

  // ── Daily heartbeat (only when no other notification was sent) ──
  if (!notified && telegramToken && telegramChatId && shouldSendHeartbeat()) {
    try {
      const nowPerth = new Intl.DateTimeFormat('en-AU', {
        timeZone: 'Australia/Perth',
        dateStyle: 'full',
        timeStyle: 'short',
      }).format(new Date());
      await sendTelegram(
        telegramToken,
        telegramChatId,
        '<b>💚 DOT PDA Monitor 运行正常</b>\n\n' +
          'Cannington 考场暂无空位。\n' +
          '系统每 10 分钟自动检查，有空位会立即通知你。\n\n' +
          `📅 检查时间: ${nowPerth} (Perth)`
      );
      log('Sent daily heartbeat via Telegram');
    } catch (err) {
      log(`Failed to send heartbeat: ${err.message}`);
    }
  }

  log('═══ Monitor complete ═══');
}

// ── Run ─────────────────────────────────────────────────────────────

monitor().catch((err) => {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
});
