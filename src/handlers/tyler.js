'use strict';

/**
 * src/handlers/tyler.js
 *
 * Playwright handler for Tyler Technologies iasWorld / TCAD property search.
 *
 * URL patterns handled:
 *   - https://propaccess.tylertech.net/clientdb/?cid=N
 *   - https://<district>.tylerhost.net/apps/assessments/
 *   - https://<district>.tylerhost.net/...iasworld...
 *
 * Search flow:
 *   1. Accept disclaimer if present
 *   2. Navigate to the search tab for the chosen search mode
 *   3. Fill owner name or account number input
 *   4. Submit and wait for results
 *   5. Extract results table
 *   6. Load individual detail pages (capped at 20 for name searches)
 */

// ─── Selectors ────────────────────────────────────────────────────────────────

// Disclaimer / Terms pages
const DISCLAIMER_SELECTORS = [
  '#ctl00_ContentPlaceHolder1_lbAccept',
  '#submitDisclaimerAccept',
  'button[id*="disclaimer" i]',
  'a:has-text("I Agree")',
  'a:has-text("I Accept")',
  'a:has-text("Agree")',
  'a:has-text("Accept")',
  'input[value*="Agree" i]',
  'input[value*="Accept" i]',
  'button:has-text("I Accept")',
  'button:has-text("I Agree")',
  'button:has-text("Agree")',
  'button:has-text("Accept")',
  'button:has-text("Continue")',
];

// Navigation tabs to reach the search form
const SEARCH_TAB_SELECTORS = [
  'a:has-text("Property Search")',
  'a:has-text("Real Property Search")',
  'a:has-text("Search")',
  'li#liSearch a',
  'a[href*="search" i]:not([href*="http"])',
  '#ctl00_masterPageMenuItems a:has-text("Search")',
  '.nav-tabs a:has-text("Search")',
];

// Owner name search tab (within a search page that has multiple search modes)
const OWNER_TAB_SELECTORS = [
  'a:has-text("Owner Name")',
  'a:has-text("Owner")',
  'li:has-text("Owner") a',
  '#owner-tab',
  'a[data-target*="owner" i]',
  'a[href*="owner" i]',
  'button:has-text("Owner")',
];

// Account/Parcel search tab
const ACCOUNT_TAB_SELECTORS = [
  'a:has-text("Account Number")',
  'a:has-text("Account")',
  'a:has-text("Parcel ID")',
  'a:has-text("Parcel Number")',
  '#account-tab',
  'a[data-target*="account" i]',
  'button:has-text("Account")',
];

// Owner name inputs — Tyler iasWorld ASP.NET IDs vary by county deployment
const OWNER_INPUT_SELECTORS = [
  '#ctl00_ContentPlaceHolder1_ownerNameSearch',
  '#ctl00_ContentPlaceHolder1_OwnerNameTextBox',
  '#ctl00_ContentPlaceHolder1_txtOwnerName',
  '#ctl00_ContentPlaceHolder1_SearchPanel1_txtOwnerName',
  'input[id*="OwnerName" i]',
  'input[id*="ownerName" i]',
  'input[name*="OwnerName" i]',
  // mapublicaccess.tylerhost.net (commonsearch.aspx) uses inpOwner
  '#inpOwner',
  'input[name="inpOwner"]',
  'input[id*="Owner" i]',
  'input[placeholder*="Owner" i]',
  'input[placeholder*="owner" i]',
  // propaccess.tylertech.net uses a different naming convention
  '#ownerName',
  'input[id*="owner"]',
];

// Account / parcel number inputs
const ACCOUNT_INPUT_SELECTORS = [
  '#ctl00_ContentPlaceHolder1_acctNumberSearch',
  '#ctl00_ContentPlaceHolder1_AcctNumTextBox',
  '#ctl00_ContentPlaceHolder1_txtAcctNum',
  '#ctl00_ContentPlaceHolder1_SearchPanel1_txtAccountNum',
  'input[id*="AcctNum" i]',
  'input[id*="AccountNum" i]',
  'input[id*="ParcelID" i]',
  'input[id*="parcelId" i]',
  'input[name*="AcctNum" i]',
  'input[name*="AccountNum" i]',
  'input[placeholder*="Account" i]',
  'input[placeholder*="Parcel" i]',
  '#accountNumber',
  'input[id*="account"]',
];

// Search submit buttons
const SEARCH_BTN_SELECTORS = [
  '#ctl00_ContentPlaceHolder1_btnSearch',
  '#ctl00_ContentPlaceHolder1_SearchPanel1_btnSearch',
  'input[type="submit"][value*="Search" i]',
  'button:has-text("Search")',
  'input[value="Search"]',
  'a.SearchButton',
  'a:has-text("Search")',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tryClick(page, selectors, timeout = 5000) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.click({ timeout });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
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

/**
 * Detect whether the current page is a disclaimer, search form, or results page.
 * Returns: 'disclaimer' | 'search' | 'results' | 'detail' | 'other'
 */
async function detectPageType(page) {
  return page.evaluate(() => {
    const body = document.body.innerText.toLowerCase();
    const url  = location.href.toLowerCase();

    if (body.includes('i agree') || body.includes('i accept') ||
        (body.includes('disclaimer') && body.includes('agree'))) return 'disclaimer';

    // Wrong portal type: county clerk / recorder / document search
    if (url.includes('docsearch') || url.includes('/recorder/') || url.includes('recorder/web') ||
        url.includes('/treasurer/') || body.includes('document number') ||
        (body.includes('grantor') && body.includes('grantee') && body.includes('recording date'))) {
      return 'wrong_type';
    }

    // Results page: has a data table with multiple rows and no search form
    const tables = document.querySelectorAll('table');
    const hasManyRows = Array.from(tables).some(t => t.querySelectorAll('tr').length > 3);

    const hasSearchInputs = document.querySelector(
      'input[id*="Owner" i], input[id*="AcctNum" i], input[id*="owner" i], input[name="inpOwner"], input[placeholder*="owner" i]'
    );

    if (url.includes('detail') || url.includes('details') || url.includes('parcel')) {
      if (!hasSearchInputs) return 'detail';
    }
    if (hasManyRows && !hasSearchInputs) return 'results';
    if (hasSearchInputs) return 'search';

    return 'other';
  });
}

async function waitForResults(page) {
  try {
    await page.waitForSelector(
      'table.SearchResults tr, #searchResults tr, table.dataGridView tr, ' +
      '.GridRow, .GridAltRow, tr.GridRow, ' +
      'table tbody tr td a',
      { timeout: 15000 }
    );
  } catch (_) {
    await page.waitForTimeout(3000);
  }
}

/**
 * Extract all labeled fields from a Tyler detail page.
 * Tyler pages use th/td pairs and dl/dt/dd structures.
 */
async function extractDetailFields(page) {
  return page.evaluate(() => {
    const data = {};

    // th/td or td/td label-value rows (adjacent-cell pattern)
    document.querySelectorAll('tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('th, td'));
      for (let i = 0; i < cells.length - 1; i++) {
        const rawLabel = cells[i].innerText.trim();
        const rawValue = cells[i + 1]?.innerText.trim() || '';
        const label = rawLabel.replace(/:$/, '');

        // Tyler Datalet format: each cell may contain "Label: Value" inline
        // If rawLabel contains a colon and rawValue also contains a colon,
        // both cells are probably self-contained — parse each individually.
        const isInlinePair = rawLabel.includes(':') && rawValue.includes(':');

        if (!isInlinePair && label && rawValue && label.length < 80 &&
            !label.match(/^\d+$/) && rawValue.length < 300) {
          data[label] = rawValue;
        }
      }
    });

    // Tyler Datalet inline "Label: Value" format (each cell is self-contained)
    document.querySelectorAll('td, th').forEach(cell => {
      const text = cell.innerText.trim();
      const colonIdx = text.indexOf(':');
      if (colonIdx > 0 && colonIdx < text.length - 1) {
        const label = text.substring(0, colonIdx).trim();
        const value = text.substring(colonIdx + 1).trim();
        if (label.length > 0 && label.length < 60 && value.length > 0 && value.length < 200 &&
            !label.match(/^\d+$/) && !data[label]) {
          data[label] = value;
        }
      }
    });

    // dl/dt/dd pairs
    document.querySelectorAll('dt').forEach(dt => {
      const dd = dt.nextElementSibling;
      if (dd?.tagName === 'DD') {
        const label = dt.innerText.trim().replace(/:$/, '');
        if (label) data[label] = dd.innerText.trim();
      }
    });

    // Labeled spans/divs (common in Tyler's newer UI)
    document.querySelectorAll('[class*="label" i]').forEach(el => {
      const next = el.nextElementSibling;
      if (next) {
        const label = el.innerText.trim().replace(/:$/, '');
        if (label && label.length < 80) data[label] = next.innerText.trim();
      }
    });

    return data;
  });
}

const TYLER_RESULT_KEYWORDS = ['owner', 'parcel', 'account', 'address', 'situs', 'location', 'property id', 'acct', 'name'];

/**
 * Extract the results table from a Tyler search results page.
 * Returns { headers, rows } or null.
 */
async function extractResultsTable(page) {
  return page.evaluate((keywords) => {
    // Tyler iasWorld uses various table IDs/classes — prefer named candidates
    const namedCandidates = [
      document.querySelector('table.SearchResults'),
      document.querySelector('#searchResults table'),
      document.querySelector('table.dataGridView'),
      document.querySelector('#gvResults'),
      document.querySelector('table[id*="grid" i]'),
      document.querySelector('table[id*="result" i]'),
    ].filter(Boolean);

    const allTables = Array.from(document.querySelectorAll('table'));
    const candidates = [...new Set([...namedCandidates, ...allTables])];

    // Score each table: keyword-matching headers beat raw row count; skip form tables
    let best = null;
    let bestScore = -1;

    for (const t of candidates) {
      // Skip tables that contain form inputs (likely search forms, not results)
      if (t.querySelector('input[type="text"], input[type="search"], select, textarea')) continue;

      const allRows = t.querySelectorAll('tr');
      if (allRows.length < 2) continue;

      const firstRowCells = Array.from(allRows[0].querySelectorAll('th, td'));
      const headerText = firstRowCells.map(el => el.innerText.trim().toLowerCase()).join(' ');
      const kwMatches = keywords.filter(kw => headerText.includes(kw)).length;

      let score;
      if (kwMatches >= 2) {
        score = 1000 + kwMatches * 10 + allRows.length;
      } else if (kwMatches === 1) {
        score = 500 + allRows.length;
      } else {
        // No header match — score only by row count (low priority)
        score = allRows.length;
      }

      if (score > bestScore) { best = t; bestScore = score; }
    }

    if (!best || bestScore < 2) return null;

    const allRows = Array.from(best.querySelectorAll('tr'));
    // Normalize headers: strip sort arrows and whitespace
    const headers = Array.from(allRows[0].querySelectorAll('th, td'))
      .map(el => el.innerText.trim().replace(/[▲▼↑↓\s]+$/, '').trim());
    const rows = allRows.slice(1).map(row => ({
      cells: Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim()),
      // Try specific detail URL patterns first, then any link in the row
      href:  row.querySelector('a[href*="detail" i], a[href*="parcel" i], a[href*="account" i], a[href*="record" i], a[href*="property" i]')?.getAttribute('href')
             || row.querySelector('td a')?.getAttribute('href')
             || row.querySelector('a')?.getAttribute('href')
             || null,
    })).filter(r => r.cells.some(c => c.length > 0));

    return headers.length > 0 && rows.length > 0 ? { headers, rows } : null;
  }, TYLER_RESULT_KEYWORDS);
}

/**
 * When result rows have no href links (ASP.NET row onclick or postback navigation),
 * click the first data row and capture the resulting detail URL.
 * Returns the detail URL string or null.
 */
async function discoverDetailUrl(page, resultsUrl) {
  try {
    // Try clicking the first link in the first data row
    const firstRowLink = page.locator('table tr:nth-child(2) a').first();
    if (await firstRowLink.count() > 0) {
      const href = await firstRowLink.getAttribute('href');
      if (href && href.startsWith('javascript:')) {
        // ASP.NET postback — click and wait for navigation
        const [_nav] = await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
          firstRowLink.click({ timeout: 5000 }),
        ]);
        const url = page.url();
        if (url !== resultsUrl) return url;
        return null;
      }
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) return href;
    }

    // No link — try clicking the row's first non-empty text cell
    const firstDataRow = page.locator('table tr').nth(1);
    if (await firstDataRow.count() === 0) return null;

    const [_nav] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
      firstDataRow.click({ timeout: 5000 }),
    ]);
    const url = page.url();
    return url !== resultsUrl ? url : null;
  } catch (e) {
    console.log(`[tyler] discoverDetailUrl failed: ${e.message?.substring(0, 80)}`);
    return null;
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page  - Already navigated to Tyler iasWorld URL
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
  onProgress(`Tyler iasWorld: searching by ${searchMode === 'account' ? 'Account Number' : 'Owner Name'}...`);
  console.log(`[tyler] mode=${searchMode} startUrl=${page.url()}`);

  // ── 1. Accept disclaimer if present ────────────────────────────────────────
  let pageType = await detectPageType(page);
  console.log(`[tyler] initial page type: ${pageType}`);

  if (pageType === 'wrong_type') {
    onProgress('Tyler handler: this URL is a recorder/clerk portal, not a CAD property search — skipping.');
    console.log('[tyler] Detected recorder/clerk/treasurer portal — returning null to trigger AI fallback');
    return null;
  }

  if (pageType === 'disclaimer') {
    onProgress('Accepting disclaimer...');
    const clicked = await tryClick(page, DISCLAIMER_SELECTORS);
    if (!clicked) {
      console.log('[tyler] Could not accept disclaimer — falling back');
      return null;
    }
    console.log(`[tyler] Accepted disclaimer via: ${clicked}`);
    pageType = await detectPageType(page);
    console.log(`[tyler] Page type after disclaimer: ${pageType}`);
  }

  // ── 2. Navigate to search form if needed ───────────────────────────────────
  if (pageType !== 'search') {
    onProgress('Navigating to search form...');
    const clicked = await tryClick(page, SEARCH_TAB_SELECTORS);
    if (clicked) {
      console.log(`[tyler] Navigated to search via: ${clicked}`);
      pageType = await detectPageType(page);
    }
  }

  // ── 3. Select the right search tab (owner vs account) ─────────────────────
  if (searchMode === 'owner') {
    // Try to click the Owner Name tab if there are multiple search tabs
    const ownerTab = await tryClick(page, OWNER_TAB_SELECTORS, 3000);
    if (ownerTab) console.log(`[tyler] Clicked owner tab: ${ownerTab}`);
  } else {
    const acctTab = await tryClick(page, ACCOUNT_TAB_SELECTORS, 3000);
    if (acctTab) console.log(`[tyler] Clicked account tab: ${acctTab}`);
  }

  // ── 4. Fill the search input ───────────────────────────────────────────────
  let filledSel = null;
  if (searchMode === 'account') {
    filledSel = await tryFill(page, ACCOUNT_INPUT_SELECTORS, accountNumber);
    console.log(`[tyler] Filled account input: ${filledSel} = ${accountNumber}`);
  } else {
    const name = fullName || (lastName && firstName ? `${lastName}, ${firstName}` : lastName || firstName || '');
    filledSel = await tryFill(page, OWNER_INPUT_SELECTORS, name);
    console.log(`[tyler] Filled owner input: ${filledSel} = ${name}`);
  }

  if (!filledSel) {
    console.log('[tyler] Could not find search input — falling back');
    return null;
  }

  // ── 5. Submit the search ───────────────────────────────────────────────────
  onProgress('Submitting search...');
  const btnClicked = await tryClick(page, SEARCH_BTN_SELECTORS);
  if (!btnClicked) {
    console.log('[tyler] Search button not found — pressing Enter');
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }
  console.log(`[tyler] After submit URL: ${page.url()}`);

  // ── 6. Wait for results ────────────────────────────────────────────────────
  onProgress('Waiting for results...');
  await waitForResults(page);

  const pagePreview = await page.evaluate(() => document.body.innerText.substring(0, 600));
  console.log(`[tyler] Results page preview:\n${pagePreview}\n---`);

  // Detect "no results" page
  const noResults = await page.evaluate(() => {
    const t = document.body.innerText.toLowerCase();
    return t.includes('no results') || t.includes('no records') ||
           t.includes('no matching') || t.includes('0 records');
  });
  if (noResults) {
    onProgress('No results found.');
    return {
      records: [], totalFound: 0,
      summary: `No records found for ${searchMode === 'account' ? 'Account: ' + accountNumber : 'Owner: ' + (fullName || lastName)}.`,
      searchedUrl: page.url(),
    };
  }

  // ── 7. Extract results table ───────────────────────────────────────────────
  const tableData = await extractResultsTable(page);
  console.log('[tyler] tableData:', JSON.stringify(tableData || null).substring(0, 400));

  if (!tableData || tableData.rows.length === 0) {
    // If we're already on a detail page (single result auto-redirect), extract directly
    const detailType = await detectPageType(page);
    if (detailType === 'detail') {
      onProgress('Single result — extracting detail...');
      const fields = await extractDetailFields(page);
      return {
        records: [{
          parcelId:         fields['Account Number'] || fields['Parcel ID'] || fields['Property ID'] || '',
          ownerName:        fields['Owner Name']     || fields['Owner']     || '',
          propertyAddress:  fields['Situs Address']  || fields['Property Address'] || fields['Address'] || '',
          legalDescription: fields['Legal Description'] || fields['Legal'] || '',
          taxAmountDue:     fields['Total Appraised'] || fields['Market Value'] || fields['Appraised Value'] || '',
          taxYear: '', paymentStatus: '', county: '', state: '',
          additionalDetails: JSON.stringify(fields),
        }],
        totalFound: 1,
        summary: `Found 1 record (Tyler iasWorld).`,
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
  const MAX_DETAILS = searchMode === 'account' ? rows.length : Math.min(rows.length, 20);
  const cappedRows  = rows.slice(0, MAX_DETAILS);
  onProgress(`Found ${rows.length} result(s). Loading details for first ${cappedRows.length}...`);

  // ── 8. Navigate to each detail page ───────────────────────────────────────
  const records = [];
  const searchResultsUrl = page.url();
  const baseUrl = new URL(page.url()).origin;

  // When all hrefs are null (ASP.NET row-click navigation), discover the URL pattern
  // by clicking the first row, then build URLs for subsequent rows from the pattern.
  let detailUrlTemplate = null;
  let detailUrlMode = null; // 'parcel' | 'sindex' | null
  let row0DetailFields = null;
  if (cappedRows.every(r => !r.href)) {
    console.log('[tyler] No hrefs in results — discovering detail URL via row click...');
    const discoveredUrl = await discoverDetailUrl(page, searchResultsUrl);
    if (discoveredUrl) {
      console.log(`[tyler] Discovered detail URL: ${discoveredUrl}`);
      // Build a template by finding what changed relative to the first row's parcel/acct ID
      const row0 = cappedRows[0];
      const obj0 = {};
      headers.forEach((h, idx) => { if (h) obj0[h] = row0.cells[idx] || ''; });
      const findVal0 = (...keys) => {
        for (const k of keys) {
          if (obj0[k]) return obj0[k];
          const m = Object.keys(obj0).find(h => h.toLowerCase().includes(k.toLowerCase()));
          if (m && obj0[m]) return obj0[m];
        }
        return '';
      };
      const acct0 = findVal0('Account Number', 'Parcel ID', 'Property ID', 'Parcel', 'Account', 'Acct #');
      const jur0  = findVal0('Jur', 'Jurisdiction', 'Jur Code');

      if (acct0 && discoveredUrl.includes(acct0)) {
        // Parcel-ID-based detail URL (e.g. /Parcel.aspx?acct={id}&jur={jur})
        detailUrlTemplate = discoveredUrl
          .replace(encodeURIComponent(acct0), '__ACCT__')
          .replace(acct0, '__ACCT__');
        if (jur0 && detailUrlTemplate.includes(jur0)) {
          detailUrlTemplate = detailUrlTemplate.replace(jur0, '__JUR__');
        }
        detailUrlMode = 'parcel';
        console.log(`[tyler] Detail URL template (parcel): ${detailUrlTemplate}`);
      } else if (/[?&]sIndex=\d/i.test(discoveredUrl)) {
        // Tyler Datalet sIndex session: extract row 0 detail immediately (we're already on it),
        // then navigate to sIndex=N directly for subsequent rows — going back to the search
        // URL would reset the server-side session and invalidate the sIndex values.
        console.log('[tyler] sIndex navigation — extracting row 0 detail immediately');
        await page.waitForSelector('table, .detail, h1, h2', { timeout: 8000 }).catch(() => {});
        row0DetailFields = await extractDetailFields(page);
        console.log(`[tyler] Row 0 sIndex detail: ${Object.keys(row0DetailFields).length} fields`);
        detailUrlTemplate = discoveredUrl.replace(/sIndex=\d+/i, 'sIndex=__IDX__');
        detailUrlMode = 'sindex';
      }

      // Navigate back to results only for parcel-template mode.
      // For sIndex mode, going back to the search URL resets the session.
      if (detailUrlMode !== 'sindex') {
        await page.goto(searchResultsUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
        await waitForResults(page);
      }
    }
  }

  for (let i = 0; i < cappedRows.length; i++) {
    const { cells, href } = cappedRows[i];
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = cells[idx] || ''; });

    // Headers vary by county (e.g. "Parcel" "Parcel ID" "Account Number" "Account")
    const findVal = (...keys) => {
      for (const k of keys) {
        if (obj[k]) return obj[k];
        const match = Object.keys(obj).find(h => h.toLowerCase().includes(k.toLowerCase()));
        if (match && obj[match]) return obj[match];
      }
      return '';
    };
    const parcelId  = findVal('Account Number', 'Parcel ID', 'Property ID', 'Parcel', 'Account', 'Acct #') || cells[1] || cells[0] || '';
    const ownerName = findVal('Owner Name', 'Owner') || cells[2] || cells[1] || '';
    const address   = findVal('Situs Address', 'Property Address', 'Address', 'Location') || cells[3] || cells[2] || '';
    const appraised = obj['Appraised Value'] || obj['Market Value'] || obj['Total Appraised'] || '';
    const jur       = findVal('Jur', 'Jurisdiction', 'Jur Code');

    const summaryRecord = {
      parcelId, ownerName, propertyAddress: address, taxAmountDue: appraised,
      legalDescription: obj['Legal Description'] || obj['Legal'] || '',
      taxYear: '', paymentStatus: '', county: '', state: '',
    };

    let detailFields = {};
    try {
      onProgress(`Loading detail for ${parcelId || 'record ' + (i + 1)}...`);
      let navigated = false;

      if (href) {
        // Direct link in result row (most Tyler sites)
        const detailUrl = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
        console.log(`[tyler] Detail URL: ${detailUrl}`);
        await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });
        navigated = true;
      } else if (detailUrlMode === 'parcel' && detailUrlTemplate) {
        // Parcel-ID-based URL template
        const detailUrl = detailUrlTemplate.replace('__ACCT__', parcelId).replace('__JUR__', jur || '');
        const fullUrl = detailUrl.startsWith('http') ? detailUrl : `${baseUrl}${detailUrl}`;
        console.log(`[tyler] Detail URL (parcel template): ${fullUrl}`);
        await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30000 });
        navigated = true;
      } else if (detailUrlMode === 'sindex' && detailUrlTemplate) {
        if (i === 0 && row0DetailFields) {
          // Row 0 was pre-extracted during discovery — reuse it
          detailFields = row0DetailFields;
          console.log(`[tyler] Using pre-extracted sIndex=0 fields (${Object.keys(detailFields).length})`);
          navigated = true;
        } else {
          // Navigate directly to sIndex=N; session stays alive as long as we don't reset via search form
          const sUrl = detailUrlTemplate.replace('__IDX__', String(i));
          const fullUrl = sUrl.startsWith('http') ? sUrl : `${baseUrl}${sUrl}`;
          console.log(`[tyler] sIndex URL (${i}): ${fullUrl}`);
          await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30000 });
          navigated = page.url() !== searchResultsUrl;
          console.log(`[tyler] After sIndex nav (${i}): ${page.url()}`);
        }
      } else if (detailUrlMode === 'index') {
        // Legacy index mode (kept for compatibility)
        const sUrl = detailUrlTemplate.replace('__IDX__', String(i));
        console.log(`[tyler] sIndex URL (${i}): ${sUrl}`);
        await page.goto(sUrl, { waitUntil: 'networkidle', timeout: 30000 });
        navigated = page.url() !== searchResultsUrl;
        console.log(`[tyler] After sIndex nav: ${page.url()}`);
      }

      if (navigated) {
        await page.waitForSelector('table, .detail, h1, h2', { timeout: 10000 }).catch(() => {});
        detailFields = await extractDetailFields(page);
        console.log(`[tyler] Detail fields (${Object.keys(detailFields).length}):`, JSON.stringify(detailFields).substring(0, 400));
        onProgress(`Extracted ${Object.keys(detailFields).length} fields.`);
      }
    } catch (err) {
      console.log(`[tyler] Detail error for ${parcelId}: ${err.message}`);
    }

    const dFind = (...keys) => {
      for (const k of keys) {
        if (detailFields[k]) return detailFields[k];
        const match = Object.keys(detailFields).find(h => h.toLowerCase().includes(k.toLowerCase()));
        if (match && detailFields[match]) return detailFields[match];
      }
      return '';
    };
    records.push({
      ...summaryRecord,
      ownerName:        dFind('Owner Name', 'Owner')                                    || summaryRecord.ownerName,
      propertyAddress:  dFind('Situs Address', 'Property Address', 'Address', 'Location') || summaryRecord.propertyAddress,
      legalDescription: dFind('Legal Description', 'Legal')                              || summaryRecord.legalDescription,
      taxAmountDue:     dFind('Total Appraised', 'Market Value', 'Appraised Value', 'Appraised') || summaryRecord.taxAmountDue,
      additionalDetails: JSON.stringify({ ...obj, ...detailFields }),
    });

    if (i < cappedRows.length - 1 && detailUrlMode !== 'index' && detailUrlMode !== 'sindex') {
      try {
        await page.goto(searchResultsUrl, { waitUntil: 'networkidle', timeout: 30000 });
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
    summary: `Found ${totalStr} record(s) for ${label} (Tyler iasWorld).`,
    searchedUrl: searchResultsUrl,
  };
}

module.exports = { search };
