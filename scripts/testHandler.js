'use strict';

/**
 * Quick handler test — run with:
 *   node scripts/testHandler.js qpublic <url> [parcelId|ownerName]
 */

require('dotenv').config();
const { chromium: chromiumExtra } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromiumExtra.use(StealthPlugin());
const chromium = chromiumExtra;

const PLATFORM = process.argv[2] || 'qpublic';
const URL_ARG  = process.argv[3];
const SEARCH   = process.argv[4] || '';

if (!URL_ARG) {
  console.error('Usage: node scripts/testHandler.js <platform> <url> <parcelId or lastName>');
  process.exit(1);
}

const HANDLER_MAP = {
  qpublic:      require('../src/tax/handlers/qpublic'),
  tyler:        require('../src/tax/handlers/tyler'),
  beacon:       require('../src/tax/handlers/beacon'),
  patriot:      require('../src/tax/handlers/patriot'),
  vision:       require('../src/tax/handlers/vision'),
  bis:          require('../src/tax/handlers/bis'),
  publicportal: require('../src/tax/handlers/publicportal'),
};

async function main() {
  const handler = HANDLER_MAP[PLATFORM];
  if (!handler) { console.error('Unknown platform:', PLATFORM); process.exit(1); }

  console.log(`\n Testing ${PLATFORM} handler`);
  console.log(`  URL   : ${URL_ARG}`);
  console.log(`  Search: ${SEARCH}\n`);

  const browser = await chromium.launch({
    headless: process.env.BROWSER_HEADLESS !== 'false',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  try {
    console.log('Navigating to URL...');
    // Use 'load' to avoid timeouts from map tiles or continuous analytics pings
    await page.goto(URL_ARG, { waitUntil: 'load', timeout: 60000 });
    // Give Angular/React SPAs a moment to mount after initial load
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    console.log('Page loaded:', page.url());

    // Detect if SEARCH looks like a parcel ID (has digits/dashes) or a name
    const isParcel = /[\d\-]/.test(SEARCH) && !/^[a-z\s]+$/i.test(SEARCH);

    const params = isParcel
      ? { accountNumber: SEARCH, onProgress: msg => console.log(' >', msg) }
      : { lastName: SEARCH,       onProgress: msg => console.log(' >', msg) };

    const result = await handler.search(page, params);

    console.log('\n── RESULT ─────────────────────────────────────');
    console.log('totalFound :', result?.totalFound);
    console.log('summary    :', result?.summary);
    console.log('searchedUrl:', result?.searchedUrl);

    if (result?.records?.length > 0) {
      console.log('\n── RECORD 1 ────────────────────────────────────');
      const r = result.records[0];
      console.log('parcelId       :', r.parcelId);
      console.log('ownerName      :', r.ownerName);
      console.log('propertyAddress:', r.propertyAddress);
      console.log('legalDescription:', r.legalDescription);
      console.log('taxAmountDue   :', r.taxAmountDue);
      if (r.additionalDetails) {
        const d = JSON.parse(r.additionalDetails);
        console.log('\nadditionalDetails (' + Object.keys(d).length + ' fields):');
        Object.entries(d).slice(0, 20).forEach(([k,v]) => console.log('  ' + k + ': ' + String(v).substring(0,80)));
      }
    }
  } catch (err) {
    console.error('Test error:', err.message);
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
