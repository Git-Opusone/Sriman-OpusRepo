'use strict';
/**
 * Verifies TX county Tax Office dual-search works by running a sample name search
 * against each county's taxUrl and checking whether useful data is returned.
 *
 * Usage:
 *   node scripts/tx-county-automation/verify-tax-offices.js
 *   node scripts/tx-county-automation/verify-tax-offices.js --county Cameron
 *   node scripts/tx-county-automation/verify-tax-offices.js --platform actweb
 *   node scripts/tx-county-automation/verify-tax-offices.js --limit 20
 *
 * Output: reports/verify-tax-offices.json
 */

require('dotenv').config();
const { chromium: chromiumExtra } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromiumExtra.use(StealthPlugin());

const fs   = require('fs');
const path = require('path');

const COUNTIES_JSON = path.join(__dirname, '../../data/counties.json');
const REPORT_DIR    = path.join(__dirname, 'reports');
const OUT_FILE      = path.join(REPORT_DIR, 'verify-tax-offices.json');

// Test search values per platform — common TX names that should return results
const TEST_SEARCH   = 'SMITH';        // owner name search (last name)
const TEST_ACCT     = '';             // leave blank to use name search

const TIMEOUT_PER_COUNTY = 90000;    // 90s max per county
const CONCURRENCY         = 1;        // sequential — browser per county is heavy

const args = process.argv.slice(2);
const filterCounty   = args.includes('--county')   ? args[args.indexOf('--county')   + 1] : null;
const filterPlatform = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : null;
const limitCount     = args.includes('--limit')    ? parseInt(args[args.indexOf('--limit') + 1]) : 999;

// ─── Load existing results for resume ────────────────────────────────────────
if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
let existing = {};
if (fs.existsSync(OUT_FILE)) {
  try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (_) {}
}

// ─── Browser agent (simplified — no AI, just Playwright) ─────────────────────

async function tryCounty(county, entry) {
  const { taxUrl, taxPlatform } = entry;
  if (!taxUrl) return { status: 'no_url' };

  const browser = await chromiumExtra.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  let result = { status: 'error', url: taxUrl, platform: taxPlatform };

  try {
    // Navigate to the tax URL
    await page.goto(taxUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    const pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');

    // Check for motor vehicle redirect (bad URL)
    if (/motor\s*vehicle|vehicle\s*renewal/i.test(pageText) && !/property\s*tax|real\s*property/i.test(pageText)) {
      result = { status: 'wrong_page', url: finalUrl, platform: taxPlatform, note: 'Motor vehicle redirect — wrong URL' };
      return result;
    }

    // Check for property tax page indicators
    const isPropertyTaxPage = /property\s*(?:tax|search)|account\s*(?:number|search)|owner\s*(?:name|search)|parcel|apprais/i.test(pageText);
    if (!isPropertyTaxPage) {
      result = { status: 'not_tax_page', url: finalUrl, platform: taxPlatform, note: pageText.slice(0, 100) };
      return result;
    }

    // Try to find and fill a search input
    const INPUT_SELECTORS = [
      'input[name="criteria"]',
      'input[placeholder*="Search"]',
      'input[placeholder*="Name"]',
      'input[placeholder*="Owner"]',
      'input[placeholder*="Account"]',
      'input[name="ownerName"]',
      'input[name="lastName"]',
      'input[name="searchText"]',
      'input[name="q"]',
      '#criteria', '#ownerName', '#searchCriteria',
      'input[type="search"]',
      'input[type="text"]',
    ];

    let inputFilled = false;
    for (const sel of INPUT_SELECTORS) {
      try {
        const el = page.locator(sel).first();
        if (await el.count({ timeout: 2000 }) > 0 && await el.isVisible({ timeout: 2000 })) {
          await el.fill(TEST_SEARCH, { timeout: 5000 });
          inputFilled = true;
          console.log(`  [${county}] filled input: ${sel}`);
          break;
        }
      } catch (_) {}
    }

    if (!inputFilled) {
      result = { status: 'no_input', url: finalUrl, platform: taxPlatform, note: 'Could not find search input' };
      return result;
    }

    // Submit
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
        page.keyboard.press('Enter'),
      ]);
      await page.waitForTimeout(2000);
    } catch (_) {
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
          page.click('input[type="submit"], button[type="submit"]', { timeout: 3000 }),
        ]);
        await page.waitForTimeout(2000);
      } catch (_2) {}
    }

    const resultsText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    const resultUrl   = page.url();

    // Count likely results
    const rowCount = await page.evaluate(() =>
      document.querySelectorAll('table tbody tr, .result-row, .property-row').length
    ).catch(() => 0);

    const hasResults = rowCount > 0 ||
      /\d+\s+(?:result|record|propert)/i.test(resultsText) ||
      /account\s*(?:no|number|#)/i.test(resultsText);

    const captcha = /captcha|recaptcha|i am not a robot|are you human/i.test(resultsText);

    if (captcha) {
      result = { status: 'captcha', url: resultUrl, platform: taxPlatform, rows: 0 };
    } else if (hasResults) {
      result = { status: 'ok', url: resultUrl, platform: taxPlatform, rows: rowCount, note: `Found results for "${TEST_SEARCH}"` };
    } else if (/no\s+(?:record|result)|not\s+found/i.test(resultsText)) {
      result = { status: 'no_results', url: resultUrl, platform: taxPlatform, rows: 0, note: `No results for "${TEST_SEARCH}" — may need different search term` };
    } else {
      result = { status: 'unknown', url: resultUrl, platform: taxPlatform, rows: rowCount, sample: resultsText.slice(0, 150) };
    }

  } catch (err) {
    result = { status: 'error', url: taxUrl, platform: taxPlatform, note: err.message.slice(0, 120) };
  } finally {
    await browser.close().catch(() => {});
  }

  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const data = JSON.parse(fs.readFileSync(COUNTIES_JSON, 'utf8'));
  const tx   = data.states.TX;

  let counties = Object.entries(tx)
    .filter(([k, v]) => k !== '_done' && v && v.taxUrl)
    .filter(([k]) => !filterCounty   || k.toLowerCase() === filterCounty.toLowerCase())
    .filter(([, v]) => !filterPlatform || v.taxPlatform === filterPlatform)
    .slice(0, limitCount);

  // Skip already done unless --county filter
  if (!filterCounty) {
    counties = counties.filter(([k]) => !existing[k] || existing[k].status === 'error');
  }

  console.log(`Testing ${counties.length} TX county tax offices (search="${TEST_SEARCH}")...`);
  console.log('Results will be written to:', OUT_FILE);

  const summary = { ok: 0, no_results: 0, captcha: 0, wrong_page: 0, no_input: 0, error: 0, other: 0 };

  for (let i = 0; i < counties.length; i++) {
    const [county, entry] = counties[i];
    process.stdout.write(`[${i+1}/${counties.length}] ${county} (${entry.taxPlatform}) ... `);

    const t0 = Date.now();
    let result;
    try {
      result = await Promise.race([
        tryCounty(county, entry),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_PER_COUNTY)),
      ]);
    } catch (e) {
      result = { status: 'error', url: entry.taxUrl, platform: entry.taxPlatform, note: e.message };
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${result.status} (${elapsed}s)${result.note ? ' — ' + result.note : ''}`);

    existing[county] = { ...result, testedAt: new Date().toISOString() };
    fs.writeFileSync(OUT_FILE, JSON.stringify(existing, null, 2));

    summary[result.status] = (summary[result.status] || 0) + 1;
  }

  console.log('\n=== SUMMARY ===');
  Object.entries(summary).filter(([, n]) => n > 0).forEach(([s, n]) => console.log(` ${s}: ${n}`));

  // Print counties needing fixes
  const needsFix = Object.entries(existing).filter(([, v]) => ['wrong_page','no_input','error'].includes(v.status));
  if (needsFix.length) {
    console.log('\nCounties needing fixes:');
    needsFix.forEach(([c, v]) => console.log(` ${c}: ${v.status} — ${v.note || v.url}`));
  }
}

main().catch(console.error);
