'use strict';

const { detectCaptcha } = require('../../shared/captchaDetector');

/**
 * src/handlers/bis.js
 *
 * Playwright handler for BIS Consultants CAD property search portals.
 * Coverage: TX-heavy (Andrews, Midland, Ector, Winkler, etc.) + some other states.
 *
 * URL patterns:
 *   - https://esearch.{county}cad.org/
 *   - https://{county}.bisconsultants.com/
 *   - https://{county}.cadcentral.com/
 *
 * Platform comes in two flavours:
 *   A) React/Angular SPA (newer deployments) — hash-routed, results rendered by JS
 *   B) Classic ASP.NET WebForms (older deployments) — standard table results
 *
 * Common traits across both:
 *   - Tabbed search: Owner Name | Account/Property ID | Address | Geographic
 *   - Detail page at {origin}/Property/View/{id}  (or /#/property/{id} for SPAs)
 *   - No CAPTCHA on Texas CAD sites
 *   - Parcel/account numbers are numeric with optional dashes (e.g. 12345-0000-0001-0000)
 */

// ─── Selectors ────────────────────────────────────────────────────────────────

// Owner Name search tab
const OWNER_TAB_SELECTORS = [
  'button[role="tab"]:has-text("Owner")',
  'li[role="tab"]:has-text("Owner")',
  'a[role="tab"]:has-text("Owner")',
  '.nav-tabs a:has-text("Owner")',
  'a:has-text("Owner Name")',
  'a:has-text("By Owner")',
  'button:has-text("Owner Name")',
  'button:has-text("Owner")',
  'li:has-text("Owner Name") a',
  '#owner-tab',
];

// Account / Property ID search tab
const ACCOUNT_TAB_SELECTORS = [
  'button[role="tab"]:has-text("Account")',
  'li[role="tab"]:has-text("Account")',
  'a[role="tab"]:has-text("Account")',
  '.nav-tabs a:has-text("Account")',
  'a:has-text("Account Number")',
  'a:has-text("Property ID")',
  'button:has-text("Account Number")',
  'button:has-text("Property ID")',
  '#account-tab',
  '#propertyid-tab',
];

// Owner name input
const OWNER_INPUT_SELECTORS = [
  'input[placeholder="Owner Name"]',
  'input[placeholder*="Owner" i]',
  'input[id="OwnerName"]',
  'input[id*="OwnerName" i]',
  'input[name="OwnerName"]',
  'input[name*="owner" i]',
  'input[aria-label*="Owner" i]',
  '#owner-search input',
  '.owner-search input',
];

// Account / Property ID input
const ACCOUNT_INPUT_SELECTORS = [
  'input[placeholder="Account Number"]',
  'input[placeholder*="Account Number" i]',
  'input[placeholder="Property ID"]',
  'input[placeholder*="Property ID" i]',
  'input[id="AccountNumber"]',
  'input[id*="AccountNumber" i]',
  'input[id="PropertyId"]',
  'input[id*="PropertyId" i]',
  'input[name="AccountNumber"]',
  'input[name*="account" i]',
  'input[aria-label*="Account" i]',
  '#account-search input',
];

// Search submit button
const SEARCH_BTN_SELECTORS = [
  'button[type="submit"]:has-text("Search")',
  'button:has-text("Search")',
  'input[type="submit"][value*="Search" i]',
  'button[class*="search" i]',
  'a:has-text("Search")',
  'input[type="submit"]',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tryClick(page, selectors, timeout = 5000) {
  if (typeof selectors === 'string') selectors = [selectors];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.click({ timeout });
        // SPAs don't fire networkidle on tab switches — wait for DOM settle instead
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(400);
        return sel;
      }
    } catch (_) {}
  }
  return null;
}

async function tryFill(page, selectors, value, timeout = 5000) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.clear({ timeout });
        await el.fill(value, { timeout });
        return sel;
      }
    } catch (_) {}
  }
  return null;
}

function isBisDomain(url) {
  return /esearch\.[a-z0-9-]+\.(org|com|net|gov)|cadcentral\.com|bisconsultants\.com/i.test(url);
}

/**
 * Wait for the page to be a usable search form.
 * SPAs may take a moment to mount; also handles ASP.NET disclaimer pages.
 */
async function ensureSearchPage(page) {
  // Bail out immediately if we've been redirected to a non-BIS domain
  // (e.g., esearch.austincad.org → austincad.org WordPress site)
  const currentUrl = page.url();
  if (!isBisDomain(currentUrl)) {
    console.log(`[bis] ensureSearchPage: non-BIS domain after redirect: ${currentUrl}`);
    return false;
  }

  // Accept any disclaimer first
  const disSelectors = [
    'input[type="submit"][value*="Accept" i]',
    'button:has-text("Accept")',
    'a:has-text("I Agree")',
    'a:has-text("Accept")',
    'button:has-text("I Agree")',
  ];
  for (const sel of disSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.click({ timeout: 5000 });
        await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
        console.log(`[bis] Accepted disclaimer via: ${sel}`);
        break;
      }
    } catch (_) {}
  }

  // Wait for any search input to appear (SPA mounting)
  try {
    await page.waitForSelector(
      'input[type="text"], input[placeholder*="search" i], input[placeholder*="owner" i], input[placeholder*="account" i]',
      { timeout: 15000 }
    );
    return true;
  } catch (_) {
    // Try navigating to explicit search path variants
    const base = new URL(page.url()).origin;
    for (const path of ['/Search', '/search', '/search/', '/#/search', '/Property/Search', '/Property/Search/']) {
      try {
        await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        const has = await page.evaluate(() =>
          document.querySelectorAll('input[type="text"], input[type="search"]').length > 0
        );
        if (has) return true;
      } catch (_) {}
    }
    return false;
  }
}

/**
 * Wait for search results to appear.
 * BIS SPAs render results into a div container; older ones use tables.
 */
async function waitForResults(page) {
  try {
    await page.waitForSelector(
      // Standard tables, Kendo Grid (Angular BIS), and SPA card layouts
      'table tbody tr td, kendo-grid tbody tr, .k-grid-content tbody tr td, ' +
      '.k-grid-table tr td, .search-results .result-row, .results-table tr, ' +
      '[class*="result" i] [class*="row" i], .property-list .property-item',
      { timeout: 15000 }
    );
    // Give Kendo Grid extra time to fully populate virtual-scroll rows
    await page.waitForTimeout(800);
  } catch (_) {
    await page.waitForTimeout(3000);
  }
}

/**
 * Extract results from both table-based and SPA div-based result layouts.
 */
async function extractResultsTable(page) {
  return page.evaluate(() => {
    // ── Table layout (ASP.NET / older BIS and BIS Kendo Grid) ────────────────
    // BIS Kendo Grid tables have recognisable column headers but no <a> links in
    // result rows — score those by data-row count, boosted by header confidence.
    const BIS_HEADER_KEYWORDS = ['property id', 'owner name', 'geo id', 'account', 'situs', 'business name'];
    const tables = Array.from(document.querySelectorAll('table'));
    let bestTable = null;
    let bestScore = 0;
    for (const t of tables) {
      const allRows = Array.from(t.querySelectorAll('tr'));
      if (allRows.length < 2) continue;

      const headerCells = Array.from(allRows[0].querySelectorAll('th, td'))
        .map(el => el.innerText.trim().toLowerCase());
      const headerMatches = BIS_HEADER_KEYWORDS.filter(k => headerCells.some(c => c.includes(k))).length;

      let score;
      if (headerMatches >= 2) {
        // BIS results table: score by data rows regardless of link presence
        const dataRows = allRows.slice(1).filter(r =>
          Array.from(r.querySelectorAll('td')).filter(c => c.innerText.trim().length > 0).length >= 2
        );
        score = dataRows.length + headerMatches * 3;
      } else {
        score = allRows.filter(r => r.querySelector('a')).length;
      }

      if (score > bestScore) { bestScore = score; bestTable = t; }
    }
    if (bestTable && bestScore > 0) {
      const allRows = Array.from(bestTable.querySelectorAll('tr'));
      const headers = Array.from(allRows[0].querySelectorAll('th, td')).map(el => el.innerText.trim());
      const rows = allRows.slice(1).map(row => ({
        cells: Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim()),
        href:  row.querySelector('a')?.getAttribute('href') || null,
      })).filter(r => r.cells.some(c => c.length > 0));
      if (headers.length > 0 && rows.length > 0) return { headers, rows, layout: 'table' };
    }

    // ── SPA / div layout (React/Angular BIS) ─────────────────────────────────
    // BIS React SPAs often render results as repeated divs with data attributes
    // or as a list of cards. We detect by looking for repeated sibling structures
    // that contain links and text resembling property data.
    const containers = [
      ...document.querySelectorAll('[class*="result" i]'),
      ...document.querySelectorAll('[class*="property-list" i] > *'),
      ...document.querySelectorAll('[class*="search-result" i]'),
    ];
    if (containers.length > 0) {
      const rows = containers.map(el => ({
        cells: [el.innerText.trim()],
        href:  el.querySelector('a')?.getAttribute('href') ||
               (el.tagName === 'A' ? el.getAttribute('href') : null),
      })).filter(r => r.cells[0].length > 0);
      // Require at least 2 items to avoid matching a lone toolbar/nav div
      if (rows.length >= 2) {
        return { headers: ['Property Info'], rows, layout: 'div' };
      }
    }

    return null;
  });
}

async function extractDetailFields(page) {
  return page.evaluate(() => {
    const data = {};
    let valueHistoryData = null;
    let taxingUnitsData  = null;
    let landMarketValue  = '';
    let improvementValue = '';
    let assessedValue    = '';

    // Helpers
    const isDollarAmt   = s => /^\$?[\d,]+(\.\d{0,2})?$/.test(s.trim());
    const isYearKey     = s => /^20[12]\d$/.test(s.trim());
    const isDecimalRate = s => /^\d+\.\d{4,6}$/.test(s.trim());

    // BIS assessment column headers — appear in value-history pivot table header
    const BIS_ASSESS_COLS = new Set([
      'improvements','land market','ag valuation','ag use','hs cap loss','assessed',
      'market value','taxable value','appraised value','assessed value',
      'productivity value','minerals','personal property',
    ]);
    const isBisAssessCol = s => BIS_ASSESS_COLS.has(s.toLowerCase().trim());

    // Entity/taxing-unit table column headers
    const ENTITY_COLS = new Set([
      'entity','tax rate','levy amount','amount due','taxes due','amount paid','balance',
    ]);
    const isEntityCol = s => ENTITY_COLS.has(s.toLowerCase().trim());

    // Pattern A: tables — structured detection first, adjacent-cell extraction last
    document.querySelectorAll('table').forEach(tbl => {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      const skipRows = new Set();

      for (let ri = 0; ri < rows.length; ri++) {
        if (skipRows.has(ri)) continue;
        const cells = Array.from(rows[ri].querySelectorAll('td, th')).map(c => c.innerText.trim());
        if (cells.length === 0) continue;

        const assessHeaderCount = cells.filter(c => isBisAssessCol(c)).length;
        const firstCellIsYear   = cells[0]?.toLowerCase().trim() === 'year';
        const entityHeaderCount = cells.filter(c => isEntityCol(c)).length;
        const hasEntityCol      = cells.some(c => /^entity$/i.test(c.trim()));

        // ── 1. Entity / taxing-unit table ─────────────────────────────────────
        // Must have an "Entity" column AND at least one entity-specific keyword.
        // Check this BEFORE assessment pivot so entity tables with "Market Value"
        // or "Taxable Value" columns don't accidentally trigger pivot detection.
        if (hasEntityCol && (entityHeaderCount >= 1 || assessHeaderCount >= 1)) {
          const entityRows = [];
          for (let di = ri + 1; di < rows.length; di++) {
            const dc = Array.from(rows[di].querySelectorAll('td, th')).map(c => c.innerText.trim());
            if (dc.length === 0 || dc.every(c => c === '')) break;
            // Stop if we hit another structured table header (assessment pivot)
            if (dc.filter(c => isBisAssessCol(c)).length >= 2 && dc.some(c => /year|improvements/i.test(c))) break;
            entityRows.push(dc.slice(0, cells.length));
            skipRows.add(di);
          }
          if (entityRows.length > 0 && !taxingUnitsData) {
            taxingUnitsData = [cells, ...entityRows];
          }
          continue;
        }

        // ── 2. BIS assessment pivot table ─────────────────────────────────────
        // Header row has ≥2 BIS assessment column keywords, followed by year rows.
        if (assessHeaderCount >= 2 || (firstCellIsYear && assessHeaderCount >= 1)) {
          const yearValues = {};
          const assessCols = cells.slice(1);
          for (let di = ri + 1; di < rows.length; di++) {
            const dc = Array.from(rows[di].querySelectorAll('td, th')).map(c => c.innerText.trim());
            if (dc.length === 0 || dc.length !== cells.length) break;
            if (!isYearKey(dc[0]) && !isDollarAmt(dc[0]) && dc[0] !== '') break;
            if (isYearKey(dc[0])) {
              const row = {};
              for (let ci = 1; ci < cells.length; ci++) {
                if (cells[ci]) row[cells[ci]] = dc[ci];
              }
              yearValues[dc[0]] = row;
            }
            // Non-year summary rows are intentionally skipped (not added to yearValues)
            skipRows.add(di);
          }

          const sortedDesc = Object.keys(yearValues).sort((a, b) => Number(b) - Number(a));
          if (sortedDesc.length > 0) {
            const latestYr = sortedDesc[0];
            data['Tax Year'] = latestYr;

            // Named scalar fields from the most recent year
            const lmKeys  = ['Land Market', 'Land Value', 'Land Non-Homesite', 'Land Homesite'];
            const imKeys  = ['Improvements', 'Improvement Value', 'Improvement Market'];
            const assKeys = ['Assessed', 'Assessed Value', 'Total Assessed'];
            for (const k of lmKeys)  { if (yearValues[latestYr][k]) { landMarketValue  = yearValues[latestYr][k]; break; } }
            for (const k of imKeys)  { if (yearValues[latestYr][k]) { improvementValue = yearValues[latestYr][k]; break; } }
            for (const k of assKeys) { if (yearValues[latestYr][k]) { assessedValue    = yearValues[latestYr][k]; break; } }

            // Build valueHistory table (oldest-first for chronological display)
            if (!valueHistoryData) {
              const sortedAsc = [...sortedDesc].sort((a, b) => Number(a) - Number(b));
              valueHistoryData = [
                ['Year', ...assessCols],
                ...sortedAsc.map(yr => [yr, ...assessCols.map(col => yearValues[yr][col] || '')]),
              ];
            }
          }
          continue;
        }

        // ── 3. Standard adjacent-cell extraction ───────────────────────────────
        // Skip cells that look like structured table headers or raw values to
        // avoid creating garbage key-value pairs (e.g. "Year":"Improvements").
        for (let i = 0; i < cells.length - 1; i++) {
          const label = cells[i].replace(/:$/, '').trim();
          const value = (cells[i + 1] || '').trim();
          if (
            label && value && label.length < 80 &&
            !isDollarAmt(label) && !isYearKey(label) && !isDecimalRate(label) &&
            !isBisAssessCol(label) && !isEntityCol(label)
          ) {
            data[label] = value;
          }
        }
      }
    });

    // Pattern B: dl/dt/dd
    document.querySelectorAll('dt').forEach(dt => {
      const dd = dt.nextElementSibling;
      if (dd?.tagName === 'DD') {
        const label = dt.innerText.trim().replace(/:$/, '');
        if (label) data[label] = dd.innerText.trim();
      }
    });

    // Pattern C: React/Angular field-label/field-value div pairs (BIS SPA)
    document.querySelectorAll('[class*="field-label" i], [class*="detail-label" i], [class*="property-label" i]').forEach(labelEl => {
      const valueEl = labelEl.nextElementSibling;
      if (valueEl) {
        const label = labelEl.innerText.trim().replace(/:$/, '');
        if (label && label.length < 80) data[label] = valueEl.innerText.trim();
      }
    });

    // Pattern D: spans with aria-label
    document.querySelectorAll('[aria-label]').forEach(el => {
      const label = el.getAttribute('aria-label').trim();
      const value = el.innerText.trim();
      if (label && value && label.length < 80) data[label] = value;
    });

    // Attach structured data as special keys (caller strips these out)
    data.__valueHistory  = valueHistoryData;
    data.__taxingUnits   = taxingUnitsData;
    data.__landMarket    = landMarketValue;
    data.__improvement   = improvementValue;
    data.__assessed      = assessedValue;

    return data;
  });
}

/**
 * Newer BIS SPA deployments (esearch.*.org) expose a REST endpoint:
 *   GET /search/SearchResults?keywords={encoded_keywords}
 * The keywords are already in the result page URL after form submission.
 * Returns: { resultsList: [{propertyId, ownerName, address, geoId, ...}] }
 */
async function tryBisSearchResultsApi(page) {
  const pageUrl = page.url();
  if (!pageUrl.includes('/search/result')) return null;

  try {
    // Extract keywords from the current URL (already URL-encoded)
    const urlObj = new URL(pageUrl);
    const keywords = (urlObj.searchParams.get('keywords') || '').trim();
    if (!keywords) return null;

    const origin  = urlObj.origin;
    // Use original encoded form from URL to avoid double-encoding
    const rawKeywords = urlObj.search.match(/keywords=([^&]*)/)?.[1] || encodeURIComponent(keywords);
    const token = urlObj.searchParams.get('searchSessionToken') || '';
    const apiUrl  = `${origin}/search/SearchResults?keywords=${rawKeywords}${token ? `&searchSessionToken=${encodeURIComponent(token)}` : ''}`;

    const result = await page.evaluate(async (url) => {
      const r = await fetch(url, {
        credentials: 'include',
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) {
        const snippet = (await r.text()).substring(0, 200);
        return { __htmlFallback: true, ct, snippet };
      }
      return r.json();
    }, apiUrl);

    if (result?.__htmlFallback) {
      console.log(`[bis] SearchResults API returned HTML (ct=${result.ct}): ${result.snippet}`);
      return null;
    }
    if (!result || !Array.isArray(result.resultsList)) return null;
    console.log(`[bis] SearchResults API returned ${result.resultsList.length} results`);
    return { items: result.resultsList, origin };
  } catch (e) {
    console.log(`[bis] SearchResults API failed: ${e.message?.substring(0, 80)}`);
    return null;
  }
}

/**
 * Build the property detail URL for a BIS site.
 * Tries the href from the results row, then falls back to the standard pattern.
 */
function buildDetailUrl(originUrl, basePath, href, propId) {
  if (href) {
    if (href.startsWith('http')) return href;
    if (href.startsWith('/')) return `${originUrl}${href}`;
    // Hash-route SPA: href="#/property/12345"
    if (href.startsWith('#')) return `${originUrl}${href}`;
    return `${originUrl}${basePath}/${href}`;
  }
  if (propId) return `${originUrl}/Property/View/${propId}`;
  return null;
}

function cleanMoney(v) {
  if (!v) return '';
  // Strip BIS pivot-table suffixes like "(=)", "(+)", "(-)" and whitespace
  const cleaned = String(v).replace(/\s*\([+\-=)]\)\s*$/, '').trim();
  // Only return if it looks like a money value (has $ or digits)
  return /[$\d,]/.test(cleaned) ? cleaned : '';
}

/**
 * Build structured additionalDetails from extractDetailFields() output.
 * Strips the __ sentinel keys and promotes them to named fields matching
 * the publicportal format that field-rules.js expects.
 */
function buildAdditionalDetails(fields, extraFlat = {}) {
  const valueHistory  = fields.__valueHistory  || null;
  const taxingUnits   = fields.__taxingUnits   || null;
  const landMarket    = fields.__landMarket    || '';
  const improvement   = fields.__improvement   || '';
  const assessed      = fields.__assessed      || '';

  // Build clean flat copy (no __ keys)
  const flat = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!k.startsWith('__')) flat[k] = v;
  }

  const ad = { ...extraFlat, ...flat };
  if (valueHistory)  ad.valueHistory      = valueHistory;
  if (taxingUnits)   ad.taxingUnits       = taxingUnits;
  if (landMarket)    ad.landMarketValue   = landMarket;
  if (improvement)   ad.improvementValue  = improvement;
  if (assessed)      ad.netAppraisedValue = assessed;
  return ad;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page  - Already navigated to BIS URL
 * @param {object} params
 * @returns {Promise<object|null>}  null signals fallback to AI agent
 */
async function search(page, {
  accountNumber = '',
  firstName = '',
  lastName = '',
  fullName = '',
  onProgress = () => {},
}) {
  const searchMode = accountNumber ? 'account' : 'owner';
  onProgress(`BIS Consultants handler: searching by ${searchMode === 'account' ? 'Account Number' : 'Owner Name'}...`);
  console.log(`[bis] mode=${searchMode} startUrl=${page.url()}`);

  // ── 0. CAPTCHA / bot-challenge check ──────────────────────────────────────
  const captcha = await detectCaptcha(page);
  if (captcha.detected) {
    onProgress(`CAPTCHA detected (${captcha.type}) — cannot proceed automatically.`);
    return { ...captcha, searchedUrl: page.url() };
  }

  // ── 1. Ensure we have a usable search form ───────────────────────────────────
  onProgress('Loading search form...');
  const ready = await ensureSearchPage(page);
  if (!ready) {
    console.log('[bis] Could not reach a search form — falling back');
    return null;
  }

  // ── 2. Click the correct search tab ─────────────────────────────────────────
  if (searchMode === 'account') {
    const clicked = await tryClick(page, ACCOUNT_TAB_SELECTORS);
    if (clicked) console.log(`[bis] Activated account tab via: ${clicked}`);
  } else {
    const clicked = await tryClick(page, OWNER_TAB_SELECTORS);
    if (clicked) console.log(`[bis] Activated owner tab via: ${clicked}`);
  }

  // The tab selectors above are loose text matches ("Account", "Owner") and
  // can catch an unrelated outbound link (e.g. a third-party "Pay Your
  // Account" link) instead of a real search tab, navigating off the BIS
  // domain entirely. Re-validate before continuing rather than plowing ahead
  // on the wrong site (this is what previously sent Hunt's account search to
  // taxpayer.justappraised.com instead of esearch.huntcad.org).
  if (!isBisDomain(page.url())) {
    console.log(`[bis] Left BIS domain after tab click: ${page.url()} — falling back`);
    return null;
  }

  // ── 3. Fill the search input ─────────────────────────────────────────────────
  let filledSelector = null;

  if (searchMode === 'account') {
    filledSelector = await tryFill(page, ACCOUNT_INPUT_SELECTORS, accountNumber);
    if (filledSelector) console.log(`[bis] Filled account: ${filledSelector} = ${accountNumber}`);
  } else {
    const name = fullName || [lastName, firstName].filter(Boolean).join(' ');
    filledSelector = await tryFill(page, OWNER_INPUT_SELECTORS, name);
    if (filledSelector) console.log(`[bis] Filled owner: ${filledSelector} = ${name}`);
  }

  if (!filledSelector) {
    console.log('[bis] Could not find search input — falling back');
    return null;
  }

  // ── 4. Submit the search ─────────────────────────────────────────────────────
  onProgress('Submitting search...');

  // Intercept the JSON API response the Angular SPA fires on search submit
  let capturedApiResponse = null;
  const responseCapture = page.waitForResponse(
    (resp) => resp.status() === 200 && /SearchResults|GetResults|searchresults/i.test(resp.url()),
    { timeout: 25000 }
  ).then(async (resp) => {
    try {
      const ct = resp.headers()['content-type'] || '';
      if (ct.includes('json')) {
        capturedApiResponse = await resp.json();
        console.log(`[bis] Intercepted API: ${resp.url()} → total=${capturedApiResponse.totalResults} page=${capturedApiResponse.page}/${capturedApiResponse.totalPages}`);
      } else {
        console.log(`[bis] Intercepted non-JSON response: ${resp.url()} ct=${ct}`);
      }
    } catch (e) {
      console.log(`[bis] Intercept parse error: ${e.message}`);
    }
  }).catch((e) => {
    console.log(`[bis] No SearchResults API call intercepted: ${e.message?.substring(0, 60)}`);
  });

  const btnSel = await tryClick(page, SEARCH_BTN_SELECTORS);
  if (!btnSel) {
    await page.keyboard.press('Enter');
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
  }
  console.log(`[bis] After submit URL: ${page.url()}`);

  // Same off-domain guard as after the tab click — a "Search" text match
  // could also land on an unrelated page.
  if (!isBisDomain(page.url())) {
    console.log(`[bis] Left BIS domain after submit: ${page.url()} — falling back`);
    return null;
  }

  // ── 5. Wait for results ──────────────────────────────────────────────────────
  onProgress('Waiting for results...');
  // SPA may navigate from /Search → /search/result?... as results load
  try {
    await page.waitForURL(url => url.includes('/search/result'), { timeout: 12000 });
  } catch (_) {}
  await waitForResults(page);
  await responseCapture; // let network interception settle
  console.log(`[bis] Results URL: ${page.url()}`);

  const preview = await page.evaluate(() => document.body.innerText.substring(0, 600));
  console.log(`[bis] Results preview:\n${preview}\n---`);

  const searchResultsUrl = page.url();

  // ── 6. Try intercepted API response, then fallback to fetch attempt ──────────
  // Use captured network response if available, otherwise try a direct fetch
  const apiData = (capturedApiResponse && Array.isArray(capturedApiResponse.resultsList))
    ? {
        items:      capturedApiResponse.resultsList,
        totalCount: capturedApiResponse.totalResults ?? capturedApiResponse.totalCount ?? capturedApiResponse.count ?? capturedApiResponse.total ?? null,
        origin:     new URL(page.url()).origin,
      }
    : await tryBisSearchResultsApi(page);
  if (apiData) {
    const { items, totalCount, origin } = apiData;
    const label = searchMode === 'account' ? `Account ${accountNumber}` : (fullName || lastName);

    if (items.length === 0) {
      onProgress('No results found.');
      return {
        records: [], totalFound: 0,
        summary: `No records found for ${label} (BIS Consultants).`,
        searchedUrl: searchResultsUrl,
      };
    }

    const MAX_API = Math.min(items.length, searchMode === 'account' ? 3 : 5);
    const capped  = items.slice(0, MAX_API);
    onProgress(`Found ${items.length} result(s) via API. Loading property cards for first ${capped.length}...`);

    const records = [];
    for (let i = 0; i < capped.length; i++) {
      const item = capped[i];
      const detailUrl = `${origin}/Property/View/${item.propertyId}`;
      let fields = {};
      try {
        onProgress(`Loading property card ${i + 1}/${capped.length}...`);
        console.log(`[bis] Detail URL: ${detailUrl}`);
        await page.goto(detailUrl, { waitUntil: 'load', timeout: 15000 });
        await page.waitForTimeout(600);
        await page.waitForSelector('table tr, [class*="detail" i], h1, h2', { timeout: 8000 }).catch(() => {});
        fields = await extractDetailFields(page);
        console.log(`[bis] Detail fields (${Object.keys(fields).length})`);
      } catch (err) {
        console.log(`[bis] Detail error for ${item.propertyId}: ${err.message}`);
      }
      records.push({
        parcelId:         fields['Account Number'] || fields['Property ID'] || item.propertyId,
        ownerName:        fields['Owner Name']     || fields['Owner']       || item.ownerName || '',
        propertyAddress:  fields['Situs Address']  || fields['Property Address'] || item.address || '',
        legalDescription: fields['Legal Description'] || fields['Legal Desc'] || item.legalDescription || '',
        taxAmountDue:     cleanMoney(fields['__assessed'] || fields['Assessed Value'] || fields['Appraised Value'] || fields['Market Value'] || fields['Total Value']) || '',
        taxYear:          fields['Tax Year'] || '',
        paymentStatus: '', county: '', state: '',
        additionalDetails: JSON.stringify(buildAdditionalDetails(fields, item)),
      });
    }

    const knownTotal = totalCount ?? items.length;
    const totalStr   = knownTotal > capped.length
      ? `${knownTotal} total, showing first ${records.length}`
      : `${records.length}`;

    return {
      records,
      totalFound: knownTotal,
      summary: `Found ${totalStr} record(s) for ${label} (BIS Consultants).`,
      searchedUrl: searchResultsUrl,
    };
  }

  // ── 7. Check for no-results ──────────────────────────────────────────────────
  const noResults = await page.evaluate(() => {
    const t = document.body.innerText.toLowerCase();
    return t.includes('no results') || t.includes('no records') ||
           t.includes('no matching') || t.includes('0 records') ||
           t.includes('0 properties');
  });
  if (noResults) {
    onProgress('No results found.');
    return {
      records: [], totalFound: 0,
      summary: `No records found for ${searchMode === 'account' ? 'Account: ' + accountNumber : 'Owner: ' + (fullName || lastName)}.`,
      searchedUrl: page.url(),
    };
  }

  // ── 8. Extract results (table or div layout) ─────────────────────────────────
  const tableData = await extractResultsTable(page);
  console.log('[bis] tableData:', JSON.stringify(tableData || null).substring(0, 400));

  if (!tableData || tableData.rows.length === 0) {
    // Single-result auto-redirect: we may already be on the detail page
    const hasDetailContent = await page.evaluate(() =>
      /\/Property\/View\//i.test(location.href) ||
      /\/#\/property\//i.test(location.href) ||
      document.querySelector('[class*="property-detail" i], [id*="propertyDetail" i]') !== null
    );
    if (hasDetailContent) {
      onProgress('Single result — extracting detail...');
      const fields = await extractDetailFields(page);
      return {
        records: [{
          parcelId:         fields['Account Number'] || fields['Property ID'] || fields['Parcel ID'] || '',
          ownerName:        fields['Owner Name']     || fields['Owner']       || '',
          propertyAddress:  fields['Situs Address']  || fields['Property Address'] || fields['Address'] || '',
          legalDescription: fields['Legal Description'] || fields['Legal Desc'] || fields['Legal'] || '',
          taxAmountDue:     cleanMoney(fields['__assessed'] || fields['Appraised Value'] || fields['Market Value'] || fields['Total Value']) || '',
          taxYear:          fields['Tax Year'] || '',
          paymentStatus: '', county: '', state: '',
          additionalDetails: JSON.stringify(buildAdditionalDetails(fields)),
        }],
        totalFound: 1,
        summary: 'Found 1 record (BIS Consultants).',
        searchedUrl: page.url(),
      };
    }

    onProgress('No results found.');
    return {
      records: [], totalFound: 0,
      summary: `No records found for ${searchMode === 'account' ? 'Account: ' + accountNumber : 'Owner: ' + (fullName || lastName)}.`,
      searchedUrl: page.url(),
    };
  }

  const { headers, rows } = tableData;
  const MAX_DETAILS = Math.min(rows.length, searchMode === 'account' ? 3 : 5);
  const cappedRows  = rows.slice(0, MAX_DETAILS);
  onProgress(`Found ${rows.length} result(s). Loading details for first ${cappedRows.length}...`);

  // ── 8. Load detail pages ─────────────────────────────────────────────────────
  const records = [];
  const originUrl        = new URL(page.url()).origin;
  const basePath         = new URL(page.url()).pathname.replace(/\/[^/]*$/, '');

  for (let i = 0; i < cappedRows.length; i++) {
    const { cells, href } = cappedRows[i];
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = cells[idx] || ''; });

    const parcelId   = obj['Account Number'] || obj['Property ID'] || obj['Acct #'] || obj['ID'] || cells[0] || '';
    const ownerName  = obj['Owner Name']     || obj['Owner']       || cells[1] || '';
    const address    = obj['Situs Address']  || obj['Address']     || obj['Location'] || cells[2] || '';
    const totalValue = obj['Appraised Value']|| obj['Market Value']|| obj['Appraised']           || '';

    const summaryRecord = {
      parcelId, ownerName, propertyAddress: address, taxAmountDue: totalValue,
      legalDescription: obj['Legal Description'] || obj['Legal Desc'] || obj['Legal'] || '',
      taxYear: '', paymentStatus: '', county: '', state: '',
    };

    let detailFields = {};
    const detailUrl = buildDetailUrl(originUrl, basePath, href, parcelId);
    try {
      if (detailUrl) {
        onProgress(`Loading detail for ${parcelId || 'record ' + (i + 1)}...`);
        console.log(`[bis] Detail URL: ${detailUrl}`);
        await page.goto(detailUrl, { waitUntil: 'load', timeout: 15000 });
        await page.waitForTimeout(600);
        await page.waitForSelector('table tr, [class*="detail" i], h1, h2', { timeout: 8000 }).catch(() => {});
        detailFields = await extractDetailFields(page);
        console.log(`[bis] Detail fields (${Object.keys(detailFields).length}):`, JSON.stringify(detailFields).substring(0, 400));
        onProgress(`Extracted ${Object.keys(detailFields).length} fields.`);
      }
    } catch (err) {
      console.log(`[bis] Detail error for ${parcelId}: ${err.message}`);
    }

    records.push({
      ...summaryRecord,
      ownerName:        detailFields['Owner Name']        || detailFields['Owner']            || summaryRecord.ownerName,
      propertyAddress:  detailFields['Situs Address']     || detailFields['Property Address'] || detailFields['Address']  || summaryRecord.propertyAddress,
      legalDescription: detailFields['Legal Description'] || detailFields['Legal Desc']       || detailFields['Legal']    || summaryRecord.legalDescription,
      taxAmountDue:     cleanMoney(detailFields['__assessed'] || detailFields['Assessed Value'] || detailFields['Appraised Value'] || detailFields['Market Value'] || detailFields['Total Value']) || summaryRecord.taxAmountDue,
      taxYear:          detailFields['Tax Year'] || summaryRecord.taxYear,
      additionalDetails: JSON.stringify(buildAdditionalDetails(detailFields, obj)),
    });

    if (i < cappedRows.length - 1) {
      try {
        await page.goto(searchResultsUrl, { waitUntil: 'load', timeout: 15000 });
        await waitForResults(page);
      } catch (_) {}
    }
  }

  const label    = searchMode === 'account' ? `Account ${accountNumber}` : (fullName || lastName);
  const totalStr = rows.length > cappedRows.length
    ? `${rows.length} total, showing first ${records.length}`
    : `${records.length}`;

  return {
    records,
    totalFound: rows.length,
    summary: `Found ${totalStr} record(s) for ${label} (BIS Consultants).`,
    searchedUrl: searchResultsUrl,
  };
}

module.exports = { search };
