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
  'a:has-text("I Agree")',
  'a:has-text("I Accept")',
  'a:has-text("Agree")',
  'a:has-text("Accept")',
  'input[value*="Agree" i]',
  'input[value*="Accept" i]',
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

    // Results page: has a data table with multiple rows and no search form
    const tables = document.querySelectorAll('table');
    const hasManyRows = Array.from(tables).some(t => t.querySelectorAll('tr').length > 3);

    const hasSearchInputs = document.querySelector(
      'input[id*="Owner" i], input[id*="AcctNum" i], input[id*="owner" i], input[placeholder*="owner" i]'
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
      'table tbody tr td a, .SearchResults tr, #searchResults tr, table.dataGridView tr',
      { timeout: 15000 }
    );
  } catch (_) {
    await page.waitForTimeout(2000);
  }
}

/**
 * Extract all labeled fields from a Tyler detail page.
 * Tyler pages use th/td pairs and dl/dt/dd structures.
 */
async function extractDetailFields(page) {
  return page.evaluate(() => {
    const data = {};

    // th/td or td/td label-value rows
    document.querySelectorAll('tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('th, td'));
      for (let i = 0; i < cells.length - 1; i++) {
        const label = cells[i].innerText.trim().replace(/:$/, '');
        const value = cells[i + 1]?.innerText.trim() || '';
        if (label && value && label.length < 80 && !label.match(/^\d+$/) && value.length < 300) {
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

/**
 * Extract the results table from a Tyler search results page.
 * Returns { headers, rows } or null.
 */
async function extractResultsTable(page) {
  return page.evaluate(() => {
    // Tyler iasWorld uses various table IDs/classes
    const candidates = [
      document.querySelector('table.SearchResults'),
      document.querySelector('#searchResults table'),
      document.querySelector('table.dataGridView'),
      document.querySelector('#gvResults'),
      ...Array.from(document.querySelectorAll('table')),
    ].filter(Boolean);

    // Pick the table with the most data rows
    let best = null;
    let bestRows = 0;
    for (const t of candidates) {
      const rows = t.querySelectorAll('tr').length;
      if (rows > bestRows) { best = t; bestRows = rows; }
    }
    if (!best || bestRows < 2) return null;

    const allRows = Array.from(best.querySelectorAll('tr'));
    const headers = Array.from(allRows[0].querySelectorAll('th, td')).map(el => el.innerText.trim());
    const rows = allRows.slice(1).map(row => ({
      cells: Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim()),
      href:  row.querySelector('a')?.getAttribute('href') || null,
    })).filter(r => r.cells.some(c => c.length > 0));

    return headers.length > 0 && rows.length > 0 ? { headers, rows } : null;
  });
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

  for (let i = 0; i < cappedRows.length; i++) {
    const { cells, href } = cappedRows[i];
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = cells[idx] || ''; });

    const parcelId  = obj['Account Number'] || obj['Parcel ID'] || obj['Property ID'] || cells[0] || '';
    const ownerName = obj['Owner Name']     || obj['Owner']     || cells[1] || '';
    const address   = obj['Situs Address']  || obj['Property Address'] || obj['Address'] || cells[2] || '';
    const appraised = obj['Appraised Value'] || obj['Market Value'] || obj['Total Appraised'] || '';

    const summaryRecord = {
      parcelId, ownerName, propertyAddress: address, taxAmountDue: appraised,
      legalDescription: obj['Legal Description'] || obj['Legal'] || '',
      taxYear: '', paymentStatus: '', county: '', state: '',
    };

    let detailFields = {};
    try {
      if (href) {
        const detailUrl = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
        onProgress(`Loading detail for ${parcelId || 'record ' + (i + 1)}...`);
        console.log(`[tyler] Detail URL: ${detailUrl}`);
        await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForSelector('table, .detail, h1, h2', { timeout: 10000 }).catch(() => {});
        detailFields = await extractDetailFields(page);
        console.log(`[tyler] Detail fields (${Object.keys(detailFields).length}):`, JSON.stringify(detailFields).substring(0, 400));
        onProgress(`Extracted ${Object.keys(detailFields).length} fields.`);
      }
    } catch (err) {
      console.log(`[tyler] Detail error for ${parcelId}: ${err.message}`);
    }

    records.push({
      ...summaryRecord,
      ownerName:        detailFields['Owner Name']        || detailFields['Owner']            || summaryRecord.ownerName,
      propertyAddress:  detailFields['Situs Address']     || detailFields['Property Address'] || detailFields['Address'] || summaryRecord.propertyAddress,
      legalDescription: detailFields['Legal Description'] || detailFields['Legal']            || summaryRecord.legalDescription,
      taxAmountDue:     detailFields['Total Appraised']   || detailFields['Market Value']     || detailFields['Appraised Value'] || summaryRecord.taxAmountDue,
      additionalDetails: JSON.stringify({ ...obj, ...detailFields }),
    });

    if (i < cappedRows.length - 1) {
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
