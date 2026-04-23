'use strict';

/**
 * src/handlers/beacon.js
 *
 * Playwright handler for Beacon / Schneider Corp property search.
 * Coverage: IA, MN, WI, OH, NE, KS, and other Midwest states.
 *
 * URL patterns handled:
 *   - https://beacon.schneidercorp.com/Application.aspx?App=<Name>&PageType=Search
 *   - https://beacon.schneidercorp.com/Application.aspx?AppID=<N>&PageType=Search
 *   - https://<county>.schneidercorp.com/... (county-hosted Beacon deployments)
 *
 * Beacon and qPublic are sister products on the same Schneider ASP.NET platform.
 * They share the same CSS class conventions (tt-upm-*) and ASP.NET control ID
 * patterns (ctlBodyPane_ctl0N_ctl01_*), so the selector strategy is identical.
 * Key Beacon differences:
 *   - Defaults to PageType=Map (GIS view) — must navigate to PageType=Search
 *   - May show a Terms & Conditions modal on first visit
 *   - Some deployments require clicking through an initial county portal page
 */

// ─── Selectors ────────────────────────────────────────────────────────────────

// Terms & Conditions modal (Bootstrap .modal.in)
const TERMS_SELECTORS = [
  'a.button-1:has-text("Agree")',
  'button:has-text("Agree")',
  'button:has-text("I Agree")',
  '.modal a:has-text("Agree")',
  '.modal button:has-text("Accept")',
  'a:has-text("I Agree")',
  'a:has-text("Accept")',
];

// Disclaimer page (older deployments, full-page redirect)
const DISCLAIMER_SELECTORS = [
  'a:has-text("Yes, I accept")',
  'a:has-text("I accept")',
  'a:has-text("Accept")',
  'input[value*="accept" i]',
  'button:has-text("Accept")',
];

// Navigate from map/home to the search page
const SEARCH_NAV_SELECTORS = [
  'li#search1 a',
  'a:has-text("Real Property Search")',
  'a:has-text("Property Search")',
  'a[href*="PageType=Search"]',
  'a:has-text("Search")',
];

// Owner name inputs — Beacon shares Schneider ASP.NET ID patterns with qPublic
const OWNER_INPUT_SELECTORS = [
  'input[id*="ctlBodyPane_ctl00"][id*="txtName"]:not([id*="Exact"])',
  'input[placeholder="enter name..."]',
  'input[id*="txtName"]:not([id*="Exact"])',
  'input[id*="OwnerName" i]',
  'input[placeholder*="owner name" i]',
  'input[id*="txtLastName" i]',
  'input[name*="LastName" i]',
];

const OWNER_FIRST_SELECTORS = [
  'input[id*="txtFirstName" i]',
  'input[name*="FirstName" i]',
  'input[placeholder*="First Name" i]',
];

// Parcel / account number inputs
const PARCEL_INPUT_SELECTORS = [
  'input[id*="txtParcelID"]',
  'input[placeholder*="parcel number" i]',
  'input[placeholder*="parcel id" i]',
  'input[id*="parcel" i]',
  'input[name*="ParcelID" i]',
];

// Search submit buttons — same tt-upm-* classes as qPublic
const PARCEL_SEARCH_BTN = 'a.tt-upm-parcelid-search-btn, a[id*="ctl02_ctl01_btnSearch"]';
const OWNER_SEARCH_BTN  = 'a.tt-upm-name-search-btn,    a[id*="ctl00_ctl01_btnSearch"]';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tryClick(page, selectors, timeout = 5000) {
  if (typeof selectors === 'string') selectors = [selectors];
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

async function dismissModal(page) {
  const hasModal = await page.evaluate(() => {
    const modal = document.querySelector('.modal.in, [role="dialog"][aria-modal="true"]');
    return !!modal;
  });
  if (!hasModal) return;

  console.log('[beacon] Modal detected — dismissing...');
  const clicked = await tryClick(page, TERMS_SELECTORS, 5000);
  if (clicked) {
    await page.waitForSelector('.modal.in, [role="dialog"]', { state: 'hidden', timeout: 5000 }).catch(() => {});
    console.log(`[beacon] Dismissed modal via: ${clicked}`);
  } else {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
}

async function detectPageType(page) {
  return page.evaluate(() => {
    const url  = location.href.toLowerCase();
    const body = document.body.innerText.toLowerCase();

    if (body.includes('i accept') || (body.includes('disclaimer') && body.includes('accept'))) return 'disclaimer';
    if (url.includes('pagetype=map') || url.includes('pagetype=1')) return 'map';

    const hasParcelInput = !!document.querySelector('input[id*="txtParcelID"], input[placeholder*="parcel number" i]');
    const hasNameInput   = !!document.querySelector('input[placeholder="enter name..."], input[id*="txtName"]');

    if (!hasParcelInput && !hasNameInput) {
      return document.querySelectorAll('a').length > 5 ? 'map' : 'error';
    }
    return 'search';
  });
}

async function clickSearchButton(page, searchMode) {
  const btnSel = searchMode === 'parcel' ? PARCEL_SEARCH_BTN : OWNER_SEARCH_BTN;
  try {
    const btn = page.locator(btnSel).first();
    if (await btn.count() === 0) return false;

    await dismissModal(page);

    try {
      await btn.click({ timeout: 5000 });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      return true;
    } catch (_) {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel.split(',')[0].trim());
        if (el) el.click();
      }, btnSel);
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      return true;
    }
  } catch (e) {
    console.log(`[beacon] Search button error: ${e.message}`);
  }
  return false;
}

async function waitForResults(page) {
  try {
    await page.waitForSelector('table tbody tr td, .results tr, #searchResults tr', { timeout: 12000 });
  } catch (_) {
    await page.waitForTimeout(2000);
  }
}

async function extractDetailFields(page) {
  return page.evaluate(() => {
    const data = {};

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

    document.querySelectorAll('dt').forEach(dt => {
      const dd = dt.nextElementSibling;
      if (dd?.tagName === 'DD') {
        const label = dt.innerText.trim().replace(/:$/, '');
        if (label) data[label] = dd.innerText.trim();
      }
    });

    document.querySelectorAll('[data-label]').forEach(el => {
      const label = el.getAttribute('data-label');
      if (label) data[label] = el.innerText.trim();
    });

    return data;
  });
}

async function extractResultsTable(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    let best = null;
    for (const t of tables) {
      const rows = t.querySelectorAll('tr').length;
      if (rows > (best ? best.querySelectorAll('tr').length : 1)) best = t;
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

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page  - Already navigated to Beacon URL
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
  onProgress(`Beacon handler: searching by ${searchMode === 'parcel' ? 'Parcel ID' : 'Owner Name'}...`);
  console.log(`[beacon] mode=${searchMode} startUrl=${page.url()}`);

  // ── 1. Handle entry pages (disclaimer / map) ───────────────────────────────
  let pageType = await detectPageType(page);
  console.log(`[beacon] initial page type: ${pageType}`);

  if (pageType === 'disclaimer') {
    onProgress('Accepting disclaimer...');
    const clicked = await tryClick(page, DISCLAIMER_SELECTORS);
    if (!clicked) {
      console.log('[beacon] Could not accept disclaimer — falling back');
      return null;
    }
    console.log(`[beacon] Accepted disclaimer via: ${clicked}`);
    pageType = await detectPageType(page);
  }

  if (pageType === 'map' || pageType === 'error') {
    onProgress('Navigating to search page...');
    const currentUrl = page.url();

    // Try clicking the Search nav tab
    const clicked = await tryClick(page, SEARCH_NAV_SELECTORS);
    if (!clicked) {
      // Build a search URL by manipulating the PageType param
      const searchUrl = currentUrl.includes('PageType=')
        ? currentUrl.replace(/PageType=[^&]*/i, 'PageType=Search')
        : currentUrl.includes('?')
          ? currentUrl + '&PageType=Search'
          : currentUrl + '?PageType=Search';
      try {
        await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
        console.log(`[beacon] Navigated to search URL: ${searchUrl}`);
      } catch (e) {
        console.log('[beacon] Could not reach search page — falling back');
        return null;
      }
    } else {
      console.log(`[beacon] Navigated via: ${clicked}`);
    }
  }

  // Dismiss any Terms modal that appeared after navigation
  await dismissModal(page);

  let currentType = await detectPageType(page);
  console.log(`[beacon] current page type: ${currentType} url: ${page.url()}`);

  if (currentType !== 'search') {
    // One final attempt: click the Search tab
    const clicked = await tryClick(page, SEARCH_NAV_SELECTORS);
    if (clicked) {
      await dismissModal(page);
      currentType = await detectPageType(page);
    }
  }

  if (currentType !== 'search') {
    console.log('[beacon] Not on search page after all attempts — falling back');
    return null;
  }

  onProgress('Search page ready.');

  // ── 2. Fill the search input ───────────────────────────────────────────────
  let filledSelector = null;

  if (searchMode === 'parcel') {
    filledSelector = await tryFill(page, PARCEL_INPUT_SELECTORS, accountNumber);
    if (filledSelector) console.log(`[beacon] Filled parcel input: ${filledSelector}`);
  } else {
    const name = fullName || lastName || '';
    filledSelector = await tryFill(page, OWNER_INPUT_SELECTORS, name);
    if (filledSelector) {
      console.log(`[beacon] Filled owner name: ${filledSelector} = ${name}`);
      if (firstName) await tryFill(page, OWNER_FIRST_SELECTORS, firstName);
    }
  }

  if (!filledSelector) {
    console.log('[beacon] Could not find search input — falling back');
    return null;
  }

  // ── 3. Click the section Search button ────────────────────────────────────
  onProgress('Submitting search...');
  const btnClicked = await clickSearchButton(page, searchMode);
  if (!btnClicked) {
    console.log('[beacon] Search button not found — pressing Enter');
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }
  console.log(`[beacon] After submit URL: ${page.url()}`);

  // ── 4. Wait for results ────────────────────────────────────────────────────
  onProgress('Waiting for results...');
  await waitForResults(page);

  const pageText = await page.evaluate(() => document.body.innerText.substring(0, 600));
  console.log(`[beacon] Results page preview:\n${pageText}\n---`);

  // ── 5. Extract results table ───────────────────────────────────────────────
  const tableData = await extractResultsTable(page);
  console.log('[beacon] tableData:', JSON.stringify(tableData || null).substring(0, 400));

  if (!tableData || tableData.rows.length === 0) {
    onProgress('No results found.');
    return {
      records: [], totalFound: 0,
      summary: `No records found for ${searchMode === 'parcel' ? 'Parcel ID: ' + accountNumber : 'Owner: ' + (fullName || lastName)}.`,
      searchedUrl: page.url(),
    };
  }

  const { headers, rows } = tableData;
  const MAX_DETAILS = searchMode === 'parcel' ? rows.length : Math.min(rows.length, 20);
  const cappedRows  = rows.slice(0, MAX_DETAILS);
  onProgress(`Found ${rows.length} result(s). Loading details for first ${cappedRows.length}...`);

  // ── 6. Navigate to each detail page ───────────────────────────────────────
  const records = [];
  const searchResultsUrl = page.url();
  const baseUrl = new URL(page.url()).origin;

  for (let i = 0; i < cappedRows.length; i++) {
    const { cells, href } = cappedRows[i];
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = cells[idx] || ''; });

    const parcelId  = obj['Parcel ID'] || obj['Parcel Number'] || obj['Account Number'] || cells[0] || '';
    const ownerName = obj['Owner Name'] || obj['Owner']         || cells[1] || '';
    const address   = obj['Property Address'] || obj['Situs Address'] || obj['Address'] || cells[2] || '';
    const appraised = obj['Appraised Value'] || obj['Total Appraised'] || obj['Market Value'] || '';

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
        console.log(`[beacon] Detail URL: ${detailUrl}`);
        await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForSelector('table, .detail, h1, h2', { timeout: 10000 }).catch(() => {});
        detailFields = await extractDetailFields(page);
        console.log(`[beacon] Detail fields (${Object.keys(detailFields).length}):`, JSON.stringify(detailFields).substring(0, 400));
        onProgress(`Extracted ${Object.keys(detailFields).length} fields.`);
      }
    } catch (err) {
      console.log(`[beacon] Detail error for ${parcelId}: ${err.message}`);
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

  const label    = searchMode === 'parcel' ? `Parcel ID ${accountNumber}` : (fullName || lastName);
  const totalStr = rows.length > cappedRows.length
    ? `${rows.length} total, showing first ${records.length}`
    : `${records.length}`;

  return {
    records,
    totalFound: rows.length,
    summary: `Found ${totalStr} record(s) for ${label} (Beacon/Schneider).`,
    searchedUrl: searchResultsUrl,
  };
}

module.exports = { search };
