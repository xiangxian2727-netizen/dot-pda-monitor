/**
 * login.js — Interactive login helper for WA DOT DoTDirect
 *
 * Launches a visible Chromium browser so you can:
 *   1. Enter your DoTDirect username and password
 *   2. Complete SMS two-factor authentication
 *   3. Solve any reCAPTCHA challenges
 *
 * Once you reach the post-login dashboard or PDA booking page,
 * the script saves your browser state (cookies, localStorage, etc.)
 * to cookies.json and prints a base64-encoded string you can paste
 * into GitHub Secrets as DOT_COOKIES.
 *
 * Usage:
 *   node login.js [--scout]
 *
 *   --scout  Scout mode: after login, follow you through the booking
 *            flow and record page structure for monitor.js development.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────
const DOT_LOGIN_URL =
  'https://www.transport.wa.gov.au/login-(to-dotdirect)';

const PDA_BOOKING_URL =
  'https://online.transport.wa.gov.au/pdabooking/manage/';

// URLs that signal the user has successfully logged in
const SUCCESS_INDICATORS = [
  '/pdabooking/',
  '/tso/selfservice/home',
  '/tso/selfservice/dashboard',
  'manage',
];

const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const SCOUT_DIR = path.join(__dirname, 'screenshots');

// ── Helpers ─────────────────────────────────────────────────────────

function log(message) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${message}`);
}

function isSuccessUrl(url) {
  return SUCCESS_INDICATORS.some((indicator) => url.includes(indicator));
}

// ── Scout mode: walk through booking flow ───────────────────────────

async function runScoutMode(page) {
  log('');
  log('╔════════════════════════════════════════════════╗');
  log('║           SCOUT MODE ACTIVE                    ║');
  log('║                                                ║');
  log('║  Please navigate through the booking flow:      ║');
  log('║  1. Go to PDA Booking                          ║');
  log('║  2. Select license class: C (Manual)           ║');
  log('║  3. Select test centre: Cannington              ║');
  log('║  4. View available dates/times                  ║');
  log('║                                                ║');
  log('║  When done, press ENTER in this terminal.       ║');
  log('╚════════════════════════════════════════════════╝');
  log('');

  // Wait for the user to press Enter
  await new Promise((resolve) => {
    process.stdin.once('data', resolve);
  });

  // Save screenshots and page HTML for analysis
  if (!fs.existsSync(SCOUT_DIR)) {
    fs.mkdirSync(SCOUT_DIR, { recursive: true });
  }

  const currentUrl = page.url();
  const title = await page.title();
  const html = await page.content();

  // Take a screenshot
  const screenshotPath = path.join(SCOUT_DIR, 'booking-page.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  log(`Screenshot saved: ${screenshotPath}`);

  // Save the page HTML
  const htmlPath = path.join(SCOUT_DIR, 'booking-page.html');
  fs.writeFileSync(htmlPath, html);
  log(`Page HTML saved: ${htmlPath}`);

  // Save current URL for reference
  const infoPath = path.join(SCOUT_DIR, 'page-info.json');
  fs.writeFileSync(
    infoPath,
    JSON.stringify({ url: currentUrl, title, timestamp: new Date().toISOString() }, null, 2)
  );
  log(`Page info saved: ${infoPath}`);

  log('');
  log('Scout data collected. Please share the screenshots/ folder');
  log('so the monitor.js selectors can be tuned.');
  log('');
}

// ── Save browser state ──────────────────────────────────────────────

async function saveBrowserState(context) {
  // Get all cookies
  const cookies = await context.cookies();

  // Get localStorage and sessionStorage from all pages
  const pages = context.pages();
  let localStorage = {};
  let sessionStorage = {};

  if (pages.length > 0) {
    try {
      localStorage = await pages[0].evaluate(() => {
        const data = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          data[key] = window.localStorage.getItem(key);
        }
        return data;
      });
    } catch (_) {
      // Page may not be accessible
    }

    try {
      sessionStorage = await pages[0].evaluate(() => {
        const data = {};
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const key = window.sessionStorage.key(i);
          data[key] = window.sessionStorage.getItem(key);
        }
        return data;
      });
    } catch (_) {
      // Page may not be accessible
    }
  }

  const state = {
    cookies,
    localStorage,
    sessionStorage,
    savedAt: new Date().toISOString(),
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };

  // Save to file
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(state, null, 2));
  log(`Browser state saved to: ${COOKIES_FILE}`);

  // Print base64 for GitHub Secret
  const base64 = Buffer.from(JSON.stringify(state)).toString('base64');
  console.log('');
  console.log('═'.repeat(60));
  console.log('  Copy this value into your GitHub Secret: DOT_COOKIES');
  console.log('═'.repeat(60));
  console.log('');
  console.log(base64);
  console.log('');
  console.log('═'.repeat(60));
  console.log(`  Or set it via CLI:`);
  console.log(`  gh secret set DOT_COOKIES --body "$(cat cookies.json | base64)"`);
  console.log('═'.repeat(60));

  return state;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const scoutMode = process.argv.includes('--scout');

  log('Starting DoTDirect login helper...');
  log(`Login URL: ${DOT_LOGIN_URL}`);
  log('');

  // Launch visible browser
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // Navigate to login page
  log('Opening login page...');
  await page.goto(DOT_LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });

  log('');
  log('╔════════════════════════════════════════════════╗');
  log('║                                                ║');
  log('║  A browser window has opened.                   ║');
  log('║                                                ║');
  log('║  Please log in to DoTDirect:                    ║');
  log('║  1. Enter your username                         ║');
  log('║  2. Enter your password                         ║');
  log('║  3. Enter SMS verification code                 ║');
  log('║  4. Complete any reCAPTCHA if prompted          ║');
  log('║                                                ║');
  log('║  The script will auto-detect successful login.  ║');
  log('╚════════════════════════════════════════════════╝');
  log('');

  // Wait for the user to reach a post-login page
  log('Waiting for successful login...');

  try {
    await page.waitForURL(
      (url) => isSuccessUrl(url.toString()),
      { timeout: 300000 } // 5 minutes for user to log in
    );
  } catch (_) {
    log('Timeout waiting for login. Did you complete the login?');
    log('Checking current URL manually...');
  }

  const currentUrl = page.url();
  log(`Current URL: ${currentUrl}`);

  if (isSuccessUrl(currentUrl)) {
    log('✅ Login detected!');
  } else {
    log('⚠️  Could not confirm login. You can still save the session.');
    log('If you are logged in but the URL didn\'t match,');
    log('please navigate to the PDA booking page before continuing.');
    log('');
    log('Press ENTER when you are on the correct page...');
    await new Promise((resolve) => {
      process.stdin.once('data', resolve);
    });
  }

  // If scout mode, let the user walk through the booking flow
  if (scoutMode) {
    await runScoutMode(page);
  }

  // Save the browser state
  await saveBrowserState(context);

  log('');
  log('Done! You can close the browser now.');
  log('The cookies have been saved. Run upload-cookies.js to');
  log('push them to GitHub Secrets, or copy the base64 string above.');

  await browser.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
