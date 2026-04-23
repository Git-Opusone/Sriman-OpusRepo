'use strict';

/**
 * src/handlers/qpublic.js
 *
 * Playwright handler for qPublic / Schneider Corp property search.
 * Coverage: FL, GA, SC, NC, AL, LA, and many more states.
 *
 * Both URL formats are supported:
 *   - Modern: qpublic.schneidercorp.com/Application.aspx?App={Name}&PageType=Search
 *   - Legacy: qpublic.net/{state}/{county}/search.html  (redirects to modern)
 *   - AppID:  qpublic.schneidercorp.com/Application.aspx?AppID=XXXX (lands on map)
 *
 * All search sections are displayed simultaneously on the search page —
 * there are no tabs to click. Each section has its own Search button.
 */

// ─── Selectors ────────────────────────────────────────────────────────────────

// Entry page: accept disclaimer (legacy qpublic.net pages)
const DISCLAIMER_SELECTORS = [
  'a:has-text("Yes, I accept")',
  'a:has-text("I accept")',
  'a:has-text("Accept")',
  'input[value*="accept" i]',
  'button:has-text("Accept")',
];

// Terms & Conditions modal that appears on first visit to schneidercorp.com
const TERMS_MODAL_SELECTORS = [
  'a.button-1:has-text("Agree")',
  'button:has-text("Agree")',
  '.modal a:has-text("Agree")',
  '[aria-label*="Terms"] a:has-text("Agree")',
];

// Entry page: navigate from map → search
const SEARCH_NAV_SELECTORS = [
  'a:has-text("Real Property Search")',
  'a:has-text("Property Search")',
  'li#search1 a',                          // Modern qPublic nav tab
  'a[href*="PageType=Search"]',
];

// qPublic modern search page inputs (ASP.NET IDs like ctlBodyPane_ctl0N_ctl01_txtXxx)
const PARCEL_INPUT_SELECTORS = [
  'input[id*="txtParcelID"]',              // ctl02 section
  'input[placeholder*="parcel number" i]',
  'input[placeholder*="parcel id" i]',
  'input[id*="parcel" i]',
  'input[name*="ParcelID" i]',
];

const OWNER_INPUT_SELECTORS = [
  'input[id*="ctlBodyPane_ctl00"][id*="txtName"]:not([id*="Exact"])', // ctl00 partial match
  'input[placeholder="enter name..."]',
  'input[id*="txtName"]:not([id*="Exact"])',
  'input[id*="OwnerName" i]',
  'input[placeholder*="owner" i]',
  'input[id*="txtLastName" i]',            // Legacy separate fields
  'input[name*="LastName" i]',
];

const OWNER_FIRST_SELECTORS = [
  'input[id*="txtFirstName" i]',
  'input[name*="FirstName" i]',
  'input[placeholder*="First Name" i]',
];

// Search submit buttons — qPublic uses <a> with __doPostBack, one per search type
// CSS class names are static across all qPublic Schneider deployments
const PARCEL_SEARCH_BTN  = 'a.tt-upm-parcelid-search-btn, a[id*="ctl02_ctl01_btnSearch"]';
const OWNER_SEARCH_BTN   = 'a.tt-upm-name-search-btn,    a[id*="ctl00_ctl01_btnSearch"]';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tryClick(page, selectors, timeout = 5000) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.click({ timeout });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
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
 * Click the correct section Search button for owner or parcel search.
 * Dismisses any blocking modal first.
 */
async function clickSearchButton(page, searchMode) {
  const btnSel = searchMode === 'parcel' ? PARCEL_SEARCH_BTN : OWNER_SEARCH_BTN;
  try {
    const btn = page.locator(btnSel).first();
    if (await btn.count() === 0) return false;

    // Dismiss any modal that may block the click
    await dismissModal(page);

    // Try normal click first
    try {
      await btn.click({ timeout: 5000 });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      console.log(`[qpublic] Clicked ${searchMode} search button: ${btnSel}`);
      return true;
    } catch (_) {
      // Modal still blocking — force click via JS dispatch
      console.log('[qpublic] Normal click blocked — using JS click');
      await page.evaluate((sel) => {
        const el = document.querySelector(sel.split(',')[0].trim());
        if (el) el.click();
      }, btnSel);
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      return true;
    }
  } catch (e) {
    console.log(`[qpublic] Search button error: ${e.message}`);
  }
  return false;
}

/**
 * Dismiss any modal dialog blocking interaction (Terms & Conditions, cookie notice, etc.).
 */
async function dismissModal(page) {
  // Check for visible modal (.modal.in is Bootstrap's "visible" state)
  const hasModal = await page.evaluate(() => {
    const modal = document.querySelector('.modal.in, [role="dialog"][aria-modal="true"]');
    return !!modal;
  });

  if (hasModal) {
    console.log('[qpublic] Modal detected — dismissing...');
    const clicked = await tryClick(page, TERMS_MODAL_SELECTORS, 5000);
    if (clicked) {
      console.log(`[qpublic] Dismissed modal via: ${clicked}`);
      // Wait for modal to close
      await page.waitForSelector('.modal.in, [role="dialog"]', { state: 'hidden', timeout: 5000 }).catch(() => {});
    } else {
      // Try pressing Escape
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      console.log('[qpublic] Dismissed modal via Escape');
    }
  }
}

async function waitForResults(page) {
  // Handle Cloudflare JS challenge — it auto-resolves in ~3-8 seconds
  const isCloudflare = await page.evaluate(() =>
    document.body.innerText.toLowerCase().includes('cloudflare') &&
    (document.body.innerText.toLowerCase().includes('verifying') ||
     document.body.innerText.toLowerCase().includes('security verification'))
  );

  if (isCloudflare) {
    console.log('[qpublic] Cloudflare challenge detected — waiting for auto-resolve...');
    // Wait up to 15s for CF to redirect to the real page
    try {
      await page.waitForFunction(
        () => !document.body.innerText.toLowerCase().includes('cloudflare') ||
              document.body.innerText.toLowerCase().includes('owner name') ||
              !!document.querySelector('table'),
        { timeout: 15000 }
      );
    } catch (_) {
      console.log('[qpublic] Cloudflare did not auto-resolve within 15s');
    }
  }

  try {
    await page.waitForSelector('table tbody tr td, .results tr, #searchResults tr', { timeout: 12000 });
  } catch (_) {
    await page.waitForTimeout(2000);
  }
}

/**
 * Check if the current page is an entry/landing page (map or disclaimer).
 * Returns 'map' | 'disclaimer' | 'search'
 */
async function detectPageType(page) {
  return page.evaluate(() => {
    const url  = location.href.toLowerCase();
    const body = document.body.innerText.toLowerCase();

    // Disclaimer: contains acceptance language
    if (body.includes('i accept') || body.includes('disclaimer') && body.includes('accept')) return 'disclaimer';

    // Map: URL has PageType=Map, or page has map-specific elements without search inputs
    if (url.includes('pagetype=map') || url.includes('pagetype=1')) return 'map';

    // Check if key search inputs are present
    const hasParcelInput = !!document.querySelector('input[id*="txtParcelID"], input[placeholder*="parcel number" i]');
    const hasNameInput   = !!document.querySelector('input[placeholder="enter name..."], input[id*="txtName"]');

    if (!hasParcelInput && !hasNameInput) {
      // No search inputs visible — probably on map or error page
      const hasNavLinks = document.querySelectorAll('a').length > 5;
      return hasNavLinks ? 'map' : 'error';
    }

    return 'search';
  });
}

/**
 * Extract all labeled fields from a detail page.
 */
async function extractDetailFields(page) {
  return page.evaluate(() => {
    const data = {};

    // th/td row pattern
    document.querySelectorAll('tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('th, td'));
      for (let i = 0; i < cells.length - 1; i++) {
        const label = cells[i].innerText.trim().replace(/:$/, '');
        const value = cells[i + 1]?.innerText.trim() || '';
        if (label && value && label.length < 80 && !label.match(/^\d+$/)) {
          data[label] = value;
        }
      }
    });

    // dt/dd pairs
    document.querySelectorAll('dt').forEach(dt => {
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD') {
        const label = dt.innerText.trim().replace(/:$/, '');
        if (label) data[label] = dd.innerText.trim();
      }
    });

    // data-label attributes
    document.querySelectorAll('[data-label]').forEach(el => {
      const label = el.getAttribute('data-label');
      if (label) data[label] = el.innerText.trim();
    });

    return data;
  });
}

/**
 * Extract results table rows.
 */
async function extractResultsTable(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    let best = null;
    // Pick the table with the most data rows
    for (const t of tables) {
      const rows = t.querySelectorAll('tr');
      if (rows.length > (best ? best.querySelectorAll('tr').length : 1)) best = t;
    }
    if (!best) return null;

    const allRows = Array.from(best.querySelectorAll('tr'));
    if (allRows.length < 2) return null;

    const headers = Array.from(allRows[0].querySelectorAll('th, td')).map(el => el.innerText.trim());
    const rows = allRows.slice(1).map(row => ({
      cells: Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim()),
      href:  row.querySelector('a')?.getAttribute('href') || null,
    })).filter(r => r.cells.some(c => c.length > 0));

    return headers.length > 0 && rows.length > 0 ? { headers, rows } : null;
  });
}

// ─── ValidateUser.aspx handler ────────────────────────────────────────────────

/**
 * ValidateUser.aspx is a Schneider Corp session-guard interstitial.
 * It appears when navigating to a deep link without an active session.
 *
 * Resolution order:
 *   1. Extract destination from query params (url / returnUrl / ReturnUrl / AppID)
 *   2. Click "Continue" / "Proceed" / "Click here" buttons on the page
 *   3. Wait up to 12 s for a JS auto-redirect away from the page
 *   4. Build a search URL from the App= query param
 *   5. Navigate to the app root as a last resort
 *
 * Returns true if we successfully left ValidateUser.aspx, false otherwise.
 */
async function handleValidateUser(page) {
  const currentUrl = page.url();
  if (!currentUrl.includes('ValidateUser.aspx')) return true; // Nothing to do

  console.log(`[qpublic] handleValidateUser: ${currentUrl}`);

  // ── 1. Try query-param destination ─────────────────────────────────────────
  const destFromParam = await page.evaluate(() => {
    const p = new URLSearchParams(location.search);
    const raw = p.get('url') || p.get('returnUrl') || p.get('ReturnUrl') || p.get('ReturnURL') || '';
    if (raw) return decodeURIComponent(raw);

    // Some deployments embed the AppID — build a search URL from it
    const appId = p.get('AppID');
    if (appId) return `https://qpublic.schneidercorp.com/Application.aspx?AppID=${appId}&PageType=Search`;

    // Build from App= param if present
    const app = p.get('App');
    if (app) return `https://qpublic.schneidercorp.com/Application.aspx?App=${app}&PageType=Search`;

    return '';
  });

  if (destFromParam && !destFromParam.includes('ValidateUser')) {
    console.log(`[qpublic] ValidateUser → navigating to param dest: ${destFromParam}`);
    try {
      await page.goto(destFromParam, { waitUntil: 'networkidle', timeout: 30000 });
      await dismissModal(page);
      return !page.url().includes('ValidateUser.aspx');
    } catch (_) {}
  }

  // ── 2. Click visible "Continue" / "Proceed" / "Click here" buttons ─────────
  const CONTINUE_SELECTORS = [
    'a:has-text("Continue")',        'button:has-text("Continue")',
    'a:has-text("Proceed")',         'button:has-text("Proceed")',
    'input[value*="Continue" i]',    'input[value*="Proceed" i]',
    'a:has-text("Click here")',      'a:has-text("click here")',
    'a:has-text("Search")',          'a[href*="PageType=Search"]',
    'a:has-text("Go to Search")',
    '#ctl00_ContentPlaceHolder1_btnContinue',
    'input[type="submit"]',
  ];

  const pageHtml = await page.evaluate(() => document.body.innerHTML.substring(0, 6000));
  console.log(`[qpublic] ValidateUser page content preview:\n${
    (await page.evaluate(() => document.body.innerText.substring(0, 400)))
  }\n---`);

  const clicked = await tryClick(page, CONTINUE_SELECTORS, 5000);
  if (clicked) {
    console.log(`[qpublic] ValidateUser → clicked: ${clicked}`);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (!page.url().includes('ValidateUser.aspx')) {
      await dismissModal(page);
      return true;
    }
  }

  // ── 3. Wait for JS auto-redirect ────────────────────────────────────────────
  console.log('[qpublic] ValidateUser → waiting for JS auto-redirect (12 s)...');
  try {
    await page.waitForFunction(
      () => !location.href.includes('ValidateUser.aspx'),
      { timeout: 12000 }
    );
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await dismissModal(page);
    console.log(`[qpublic] ValidateUser → JS redirect resolved to: ${page.url()}`);
    return true;
  } catch (_) {
    console.log('[qpublic] ValidateUser → JS redirect timed out');
  }

  // ── 4. Navigate to app root (strip ValidateUser path, go to base) ───────────
  try {
    const appRoot = new URL(currentUrl);
    // Try the schneidercorp root — session may be established now
    const rootUrl = appRoot.origin + '/Application.aspx';
    const appParam = appRoot.searchParams.get('App') || appRoot.searchParams.get('AppID');
    const fallbackUrl = appParam
      ? `${appRoot.origin}/Application.aspx?App=${appParam}&PageType=Search`
      : rootUrl;
    console.log(`[qpublic] ValidateUser → trying app root: ${fallbackUrl}`);
    await page.goto(fallbackUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await dismissModal(page);
    return !page.url().includes('ValidateUser.aspx');
  } catch (_) {}

  console.log('[qpublic] ValidateUser → all resolution attempts failed');
  return false;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page  - Already navigated to qPublic URL
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
  const searchMode = accountNumber ? 'parcel' : 'owner';
  onProgress(`qPublic handler: searching by ${searchMode === 'parcel' ? 'Parcel ID' : 'Owner Name'}...`);
  console.log(`[qpublic] mode=${searchMode} startUrl=${page.url()}`);

  // ── 1. Handle entry pages (disclaimer / map) ───────────────────────────────
  const pageType = await detectPageType(page);
  console.log(`[qpublic] detected page type: ${pageType}`);

  if (pageType === 'disclaimer') {
    onProgress('Accepting disclaimer...');
    const clicked = await tryClick(page, DISCLAIMER_SELECTORS);
    if (!clicked) {
      console.log('[qpublic] Could not accept disclaimer — falling back');
      return null;
    }
    console.log(`[qpublic] Accepted disclaimer via: ${clicked}`);
    const nextType = await detectPageType(page);
    console.log(`[qpublic] Page type after disclaimer: ${nextType}`);
    if (nextType !== 'search') {
      await tryClick(page, SEARCH_NAV_SELECTORS);
    }
  }

  if (pageType === 'map' || pageType === 'error') {
    const currentUrl = page.url();
    if (currentUrl.includes('ValidateUser.aspx')) {
      onProgress('Handling session validation...');
      await handleValidateUser(page);
    } else {
      onProgress('Navigating to search page...');
      const clicked = await tryClick(page, SEARCH_NAV_SELECTORS);
      if (!clicked) {
        const searchUrl = currentUrl.includes('?')
          ? currentUrl.replace(/PageType=[^&]*/i, 'PageType=Search')
          : currentUrl + '?PageType=Search';
        try {
          await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
          console.log(`[qpublic] Navigated to search URL: ${searchUrl}`);
        } catch (e) {
          console.log('[qpublic] Could not reach search page — falling back');
          return null;
        }
      } else {
        console.log(`[qpublic] Navigated via: ${clicked}`);
      }
    }
  }

  // Verify we're on the search page now; handle ValidateUser.aspx if present
  let currentType = await detectPageType(page);
  console.log(`[qpublic] Current page type: ${currentType} url: ${page.url()}`);

  if (page.url().includes('ValidateUser.aspx')) {
    onProgress('Session validation — resolving...');
    const resolved = await handleValidateUser(page);
    if (!resolved) {
      console.log('[qpublic] ValidateUser resolution failed — falling back');
      return null;
    }
    currentType = await detectPageType(page);
    console.log(`[qpublic] After ValidateUser resolution, type: ${currentType} url: ${page.url()}`);
  }

  if (currentType !== 'search') {
    // One last try: click the Search nav tab
    const clicked = await tryClick(page, SEARCH_NAV_SELECTORS);
    if (clicked) {
      await dismissModal(page);
      currentType = await detectPageType(page);
    }
  }

  if (currentType !== 'search') {
    console.log('[qpublic] Not on search page after all attempts — falling back');
    return null;
  }

  onProgress('Search page ready.');

  // ── 2. Fill the appropriate search input ──────────────────────────────────
  let filledSelector = null;

  if (searchMode === 'parcel') {
    filledSelector = await tryFill(page, PARCEL_INPUT_SELECTORS, accountNumber);
    if (filledSelector) {
      console.log(`[qpublic] Filled parcel input: ${filledSelector}`);
    }
  } else {
    const nameForSearch = fullName || lastName || '';
    filledSelector = await tryFill(page, OWNER_INPUT_SELECTORS, nameForSearch);
    if (filledSelector) {
      console.log(`[qpublic] Filled owner name: ${filledSelector} = ${nameForSearch}`);
      // Try filling first name too if present
      if (firstName) await tryFill(page, OWNER_FIRST_SELECTORS, firstName);
    }
  }

  if (!filledSelector) {
    console.log('[qpublic] Could not find search input — falling back');
    return null;
  }

  // ── 3. Click the correct section Search button ────────────────────────────
  onProgress('Submitting search...');
  const clicked = await clickSearchButton(page, searchMode);
  if (!clicked) {
    console.log('[qpublic] Search button not found — pressing Enter as fallback');
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }

  console.log(`[qpublic] After submit URL: ${page.url()}`);

  // ── 4. Wait for results (with Cloudflare challenge handling) ───────────────
  onProgress('Waiting for results...');
  await waitForResults(page);

  // Capture page text; detect and wait through Cloudflare if needed
  let pageText = await page.evaluate(() => document.body.innerText.substring(0, 800));
  const isCF = pageText.toLowerCase().includes('cloudflare') &&
               (pageText.toLowerCase().includes('verifying') ||
                pageText.toLowerCase().includes('security verification') ||
                pageText.toLowerCase().includes('ray id'));

  if (isCF) {
    console.log('[qpublic] Cloudflare challenge — waiting up to 15s for auto-resolve...');
    onProgress('Cloudflare security check — waiting...');
    try {
      await page.waitForFunction(
        () => !document.body.innerText.toLowerCase().includes('ray id') &&
              !document.body.innerText.toLowerCase().includes('security verification'),
        { timeout: 15000 }
      );
      pageText = await page.evaluate(() => document.body.innerText.substring(0, 800));
      console.log('[qpublic] Cloudflare resolved.');
    } catch (_) {
      console.log('[qpublic] Cloudflare did not auto-resolve — returning empty results');
      return {
        records: [], totalFound: 0,
        summary: 'Search blocked by Cloudflare security check on qPublic. Try again in a few minutes.',
        searchedUrl: page.url(),
      };
    }
  }

  console.log(`[qpublic] Results page preview:\n${pageText}\n---`);

  // ── 5. Extract results table ───────────────────────────────────────────────
  const tableData = await extractResultsTable(page);
  console.log('[qpublic] tableData:', JSON.stringify(tableData || null).substring(0, 400));

  if (!tableData || tableData.rows.length === 0) {
    onProgress('No results found.');
    return {
      records: [],
      totalFound: 0,
      summary: `No records found for ${searchMode === 'parcel' ? 'Parcel ID: ' + accountNumber : 'Owner: ' + (fullName || lastName)}.`,
      searchedUrl: page.url(),
    };
  }

  const { headers, rows } = tableData;

  // Cap detail page loading — for parcel searches load all (usually 1),
  // for owner name searches cap at 20 to stay responsive
  const MAX_DETAILS = searchMode === 'parcel' ? rows.length : Math.min(rows.length, 20);
  const cappedRows = rows.slice(0, MAX_DETAILS);
  onProgress(`Found ${rows.length} result(s). Loading details for first ${cappedRows.length}...`);

  // ── 6. Navigate to detail page for each result ─────────────────────────────
  const records = [];
  const searchResultsUrl = page.url();
  const baseUrl = new URL(page.url()).origin;

  for (let i = 0; i < cappedRows.length; i++) {
    const { cells, href } = cappedRows[i];
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = cells[idx] || ''; });

    const parcelId   = obj['Parcel ID'] || obj['Parcel Number'] || obj['Account Number'] || cells[0] || '';
    const ownerName  = obj['Owner Name'] || obj['Owner']         || cells[1] || '';
    const address    = obj['Property Address'] || obj['Situs Address'] || obj['Address'] || cells[2] || '';
    const appraised  = obj['Appraised Value'] || obj['Total Appraised'] || obj['Market Value'] || '';

    const summaryRecord = {
      parcelId, ownerName, propertyAddress: address, taxAmountDue: appraised,
      legalDescription: obj['Legal Description'] || obj['Legal'] || '',
      taxYear: '', paymentStatus: '', county: '', state: '',
    };

    let detailFields = {};
    try {
      let detailUrl = '';
      if (href) {
        detailUrl = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
      }

      if (detailUrl) {
        onProgress(`Loading detail for ${parcelId || 'record ' + (i + 1)}...`);
        console.log(`[qpublic] Detail URL: ${detailUrl}`);
        await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForSelector('table, .detail, h1, h2', { timeout: 10000 }).catch(() => {});
        detailFields = await extractDetailFields(page);
        console.log(`[qpublic] Detail fields (${Object.keys(detailFields).length}):`, JSON.stringify(detailFields).substring(0, 600));
        onProgress(`Extracted ${Object.keys(detailFields).length} detail fields.`);
      }
    } catch (err) {
      console.log(`[qpublic] Detail error for ${parcelId}: ${err.message}`);
    }

    records.push({
      ...summaryRecord,
      ownerName:        detailFields['Owner Name']          || detailFields['Owner']            || summaryRecord.ownerName,
      propertyAddress:  detailFields['Situs Address']       || detailFields['Property Address'] || detailFields['Address'] || summaryRecord.propertyAddress,
      legalDescription: detailFields['Legal Description']   || detailFields['Legal']            || summaryRecord.legalDescription,
      taxAmountDue:     detailFields['Total Appraised']     || detailFields['Market Value']     || detailFields['Appraised Value'] || summaryRecord.taxAmountDue,
      additionalDetails: JSON.stringify({ ...obj, ...detailFields }),
    });

    if (i < cappedRows.length - 1) {
      try {
        await page.goto(searchResultsUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await waitForResults(page);
      } catch (_) {}
    }
  }

  const label = searchMode === 'parcel' ? `Parcel ID ${accountNumber}` : (fullName || lastName);
  const totalStr = rows.length > cappedRows.length
    ? `${rows.length} total, showing first ${records.length}`
    : `${records.length}`;
  return {
    records,
    totalFound: rows.length,
    summary: `Found ${totalStr} record(s) for ${label} (qPublic).`,
    searchedUrl: searchResultsUrl,
  };
}

module.exports = { search };
