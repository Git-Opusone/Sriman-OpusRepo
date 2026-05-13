'use strict';

const { detectCaptcha } = require('../../shared/captchaDetector');

/**
 * src/handlers/vision.js
 *
 * Playwright handler for Vision Government Solutions property assessment portals.
 * Coverage: MA, NH, CT, RI, VT, ME — across both hosting variants:
 *   - gis.vgsi.com/{CityState}/          (e.g. gis.vgsi.com/SomervilleMA/)
 *   - www.visionappraisal.com/databases/{ST}/{TOWN}/
 *
 * The interface is ASP.NET WebForms with an UpdatePanel (partial-page AJAX). Key traits:
 *   - Search tab links use LinkButton postbacks — clicking them may not cause full navigation
 *   - Search fields use long ASP.NET naming: ctl00$MainContent$SearchControl1$txt*
 *   - Results are in an ASP.NET GridView rendered as a plain <table>
 *   - Property card URL: .../Parcel.aspx?pid={ID}  or  Search/search_parcel.aspx?pid={ID}
 *
 * Tab IDs across deployments vary, so we detect by label text where possible.
 */

// ─── Selectors ────────────────────────────────────────────────────────────────

// Owner search tab (LinkButton or <a>)
const OWNER_TAB_SELECTORS = [
  'a:has-text("Owner Name")',
  'a:has-text("By Owner")',
  'a:has-text("Owner")',
  'input[type="submit"][value*="Owner" i]',
  '[id*="lbtnOwner" i]',
  '[id*="lnkOwner" i]',
  'td.tab:has-text("Owner")',
];

// Parcel/MBLU search tab
const PARCEL_TAB_SELECTORS = [
  'a:has-text("Parcel ID")',
  'a:has-text("Map/Lot")',
  'a:has-text("MBLU")',
  'a:has-text("Parcel")',
  '[id*="lbtnParcel" i]',
  '[id*="lnkParcel" i]',
  'td.tab:has-text("Parcel")',
];

// Owner last name
const LAST_NAME_SELECTORS = [
  'input[id*="txtLastName"]',
  'input[name*="txtLastName"]',
  'input[id*="LastName" i]',
  'input[placeholder*="Last Name" i]',
  'input[name*="LastName" i]',
];

// Owner first name
const FIRST_NAME_SELECTORS = [
  'input[id*="txtFirstName"]',
  'input[name*="txtFirstName"]',
  'input[id*="FirstName" i]',
  'input[placeholder*="First Name" i]',
  'input[name*="FirstName" i]',
];

// Single owner-name field (some deployments use txtSearchOwner — single combined field)
const SINGLE_OWNER_SELECTORS = [
  'input[id*="txtSearchOwner"]',
  'input[name*="txtSearchOwner"]',
  'input[id*="SearchOwner" i]',
  'input[placeholder*="Owner" i]',
  'input[name*="Owner" i]',
];

// Parcel / MBLU input
const PARCEL_INPUT_SELECTORS = [
  'input[id*="txtMBLU"]',
  'input[name*="txtMBLU"]',
  'input[id*="txtSearchPid"]',
  'input[name*="txtSearchPid"]',
  'input[id*="txtParcel"]',
  'input[name*="txtParcel"]',
  'input[id*="ParcelID" i]',
  'input[placeholder*="Parcel" i]',
  'input[placeholder*="MBLU" i]',
  'input[id*="MBLU" i]',
];

// Search submit button
const SEARCH_BTN_SELECTORS = [
  'input[id*="btnSearch"]',
  'input[name*="btnSearch"]',
  'input[id*="btnSubmit"]',
  'input[name*="btnSubmit"]',
  'input[type="submit"][value*="Search" i]',
  'button:has-text("Search")',
  'a:has-text("Search")',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tryClick(page, selectors, timeout = 5000) {
  if (typeof selectors === 'string') selectors = [selectors];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.click({ timeout });
        // Vision uses UpdatePanel — networkidle may not fire; wait for DOM settle
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(500);
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

async function navigateToSearchPage(page) {
  const url = page.url();

  const hasTextInputs = () => page.evaluate(() =>
    document.querySelectorAll('input[type="text"], input:not([type])').length > 0
  );

  // If the page already has real text inputs, we're on the search form
  if (await hasTextInputs()) return true;

  // Some Vision deployments show a landing page with an "Enter Online Database" button.
  // Clicking it navigates to Search.aspx where the actual form lives.
  const enterBtnSels = [
    'input[id*="btnEnter"]',
    'input[value*="Enter Online" i]',
    'input[value*="Online Database" i]',
    'a:has-text("Enter Online Database")',
    'input[type="submit"]:not([value*="Search" i])',
  ];
  for (const sel of enterBtnSels) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        console.log(`[vision] Clicking landing-page button: ${sel}`);
        await el.click({ timeout: 5000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(400);
        if (await hasTextInputs()) {
          console.log(`[vision] Reached search form via landing button: ${page.url()}`);
          return true;
        }
        break;
      }
    } catch (_) {}
  }

  // Accept any ASP.NET WebForms page (VIEWSTATE present) — owner/parcel inputs
  // appear after clicking a search-type tab (UpdatePanel postback).
  const hasViewState = await page.evaluate(() =>
    !!document.querySelector('input[name="__VIEWSTATE"]')
  );
  if (hasViewState) return true;

  // Try common Vision search sub-paths
  const base = url.endsWith('/') ? url : url.replace(/\/[^/]*$/, '/');
  const searchUrls = [
    `${base}Search/Search.aspx`,
    `${base}Search.aspx`,
    `${base}Default.aspx`,
    `${base}search.aspx`,
  ];

  for (const u of searchUrls) {
    try {
      console.log(`[vision] Trying search URL: ${u}`);
      await page.goto(u, { waitUntil: 'networkidle', timeout: 30000 });
      const has = await page.evaluate(() =>
        !!document.querySelector('input[name="__VIEWSTATE"]') ||
        document.querySelectorAll('input[type="text"]').length > 0
      );
      if (has) return true;
    } catch (_) {}
  }
  return false;
}

async function waitForGridResults(page) {
  // Vision renders results in ASP.NET GridView — wait for table rows with links
  try {
    await page.waitForSelector(
      'table[id*="GridView"] tr td, table[id*="grid" i] tr td, .GridViewStyle tr td',
      { timeout: 15000 }
    );
  } catch (_) {
    // Fallback: any table row with a link
    try {
      await page.waitForSelector('table tr td a', { timeout: 5000 });
    } catch (__) {
      await page.waitForTimeout(2000);
    }
  }
}

async function extractResultsTable(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    let best = null;
    let bestScore = 0;
    for (const t of tables) {
      const rows = Array.from(t.querySelectorAll('tr'));
      const linkRows = rows.filter(r => r.querySelector('a'));
      if (linkRows.length > bestScore) {
        bestScore = linkRows.length;
        best = t;
      }
    }
    if (!best || bestScore === 0) return null;

    const allRows = Array.from(best.querySelectorAll('tr'));
    if (allRows.length < 2) return null;

    // Header row — Vision GridViews use <th> or first <td> row
    const firstRow = allRows[0];
    const headers = Array.from(firstRow.querySelectorAll('th, td')).map(el => el.innerText.trim());

    const rows = allRows.slice(1).map(row => ({
      cells: Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim()),
      href:  row.querySelector('a')?.getAttribute('href') || null,
    })).filter(r => r.cells.some(c => c.length > 0));

    return headers.length > 0 && rows.length > 0 ? { headers, rows } : null;
  });
}

async function extractDetailFields(page) {
  return page.evaluate(() => {
    const data = {};

    // Pattern A: table label/value pairs
    document.querySelectorAll('table tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td, th'));
      for (let i = 0; i < cells.length - 1; i++) {
        const label = cells[i].innerText.trim().replace(/:$/, '');
        const value = cells[i + 1]?.innerText.trim() || '';
        if (label && value && label.length < 80 && !label.match(/^\d+$/)) {
          data[label] = value;
        }
      }
    });

    // Pattern B: <dt>/<dd>
    document.querySelectorAll('dt').forEach(dt => {
      const dd = dt.nextElementSibling;
      if (dd?.tagName === 'DD') {
        const label = dt.innerText.trim().replace(/:$/, '');
        if (label) data[label] = dd.innerText.trim();
      }
    });

    // Pattern C: Vision often puts owner / location in labeled <span> pairs
    document.querySelectorAll('span[id*="lbl" i], span[id*="Label" i]').forEach(span => {
      const label = span.innerText.trim().replace(/:$/, '');
      const next  = span.nextElementSibling;
      if (label && next) data[label] = next.innerText.trim();
    });

    return data;
  });
}

// ─── Async.asmx API (newer Vision deployments) ───────────────────────────────

/**
 * Newer gis.vgsi.com deployments expose an async.asmx/GetData2 JSON endpoint
 * for autocomplete search.  POST {"inVal": term, "src": "i_owner"|"i_pid"|"i_mblu"}
 * Returns {"d": [{id, value, source}]} — id is the property PID.
 */
async function tryAsyncApi(page, { ownerName, pid }) {
  const u = new URL(page.url());
  // Strip any .aspx filename from pathname to get the base directory
  const basePart = u.pathname.replace(/\/[^/]*\.aspx.*$/, '').replace(/\/?$/, '/');
  const baseUrl  = `${u.origin}${basePart}`;
  const apiUrl   = `${baseUrl}async.asmx/GetData2`;

  const src   = pid ? 'i_pid' : 'i_owner';
  const inVal = pid || ownerName;

  try {
    const result = await page.evaluate(async ({ url, body }) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
      });
      if (!r.ok) return null;
      return r.json();
    }, { url: apiUrl, body: { inVal, src } });

    if (!result || !Array.isArray(result.d)) return null;
    console.log(`[vision] async.asmx returned ${result.d.length} results (src=${src})`);
    return { items: result.d, baseUrl };
  } catch (e) {
    console.log(`[vision] async.asmx unavailable: ${e.message?.substring(0, 80)}`);
    return null;
  }
}

async function loadDetailPage(page, pid, baseUrl, label, onProgress) {
  const detailUrl = `${baseUrl}Parcel.aspx?pid=${pid}`;
  try {
    onProgress(`Loading property card for ${label}...`);
    console.log(`[vision] Property card URL: ${detailUrl}`);
    await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('table tr, h1, h2', { timeout: 10000 }).catch(() => {});
    const fields = await extractDetailFields(page);
    console.log(`[vision] Detail fields (${Object.keys(fields).length})`);
    return fields;
  } catch (err) {
    console.log(`[vision] Detail error for pid=${pid}: ${err.message}`);
    return {};
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page  - Already navigated to Vision URL
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
  onProgress(`Vision Government Solutions handler: searching by ${searchMode === 'parcel' ? 'Parcel ID' : 'Owner Name'}...`);
  console.log(`[vision] mode=${searchMode} startUrl=${page.url()}`);

  // ── 0. CAPTCHA / bot-challenge check ──────────────────────────────────────
  const captcha = await detectCaptcha(page);
  if (captcha.detected) {
    onProgress(`CAPTCHA detected (${captcha.type}) — cannot proceed automatically.`);
    return { ...captcha, searchedUrl: page.url() };
  }

  // ── 1. Navigate to the search form ──────────────────────────────────────────
  const reachedSearch = await navigateToSearchPage(page);
  if (!reachedSearch) {
    console.log('[vision] Could not reach a search form page — falling back');
    return null;
  }

  // ── 2. Try async.asmx API (newer deployments — gis.vgsi.com style) ──────────
  const ownerSearch = fullName || [firstName, lastName].filter(Boolean).join(' ') || lastName;
  const apiData = await tryAsyncApi(page, {
    ownerName: searchMode === 'owner' ? (lastName || fullName) : null,
    pid: searchMode === 'parcel' ? accountNumber : null,
  });

  if (apiData) {
    const { items, baseUrl } = apiData;
    const label = searchMode === 'parcel' ? `Parcel ID ${accountNumber}` : ownerSearch;

    if (items.length === 0) {
      onProgress('No results found.');
      return {
        records: [], totalFound: 0,
        summary: `No records found for ${label} (Vision Government Solutions).`,
        searchedUrl: page.url(),
      };
    }

    const MAX_DETAILS = searchMode === 'parcel' ? items.length : Math.min(items.length, 20);
    const capped = items.slice(0, MAX_DETAILS);
    onProgress(`Found ${items.length} result(s). Loading property cards for first ${capped.length}...`);

    const records = [];
    for (let i = 0; i < capped.length; i++) {
      const item = capped[i];
      const fields = await loadDetailPage(page, item.id, baseUrl, item.value || `record ${i + 1}`, onProgress);
      records.push({
        parcelId:        fields['PID'] || fields['Parcel ID'] || fields['Acct#'] || item.id,
        ownerName:       fields['Owner'] || fields['Owner Name'] || item.value || '',
        propertyAddress: fields['Location'] || fields['Address'] || fields['Property Address'] || fields['Situs Address'] || '',
        legalDescription: fields['Use Code'] || fields['Use'] || fields['Description'] || '',
        taxAmountDue:    fields['Total'] || fields['Assessment'] || fields['Total Value'] || fields['Appraised Value'] || '',
        taxYear: '', paymentStatus: '', county: '', state: '',
        additionalDetails: JSON.stringify(fields),
      });
    }

    const totalStr = items.length > capped.length
      ? `${items.length} total, showing first ${records.length}`
      : `${records.length}`;

    return {
      records,
      totalFound: items.length,
      summary: `Found ${totalStr} record(s) for ${label} (Vision Government Solutions).`,
      searchedUrl: `${baseUrl}Parcel.aspx`,
    };
  }

  // ── 3. Fall back: form-based search (older deployments) ─────────────────────
  // Pattern A: tab link/button (LinkButton postback on older visionappraisal.com)
  if (searchMode === 'parcel') {
    const clicked = await tryClick(page, PARCEL_TAB_SELECTORS);
    if (clicked) console.log(`[vision] Activated parcel tab via: ${clicked}`);
  } else {
    const clicked = await tryClick(page, OWNER_TAB_SELECTORS);
    if (clicked) console.log(`[vision] Activated owner tab via: ${clicked}`);
  }

  // Pattern B: search-type dropdown
  const searchTypeDdl = page.locator('[id*="ddlSearch"], [name*="ddlSearch"]').first();
  if (await searchTypeDdl.count() > 0) {
    const opts = await page.evaluate(() => {
      const sel = document.querySelector('[id*="ddlSearch"]');
      return sel ? Array.from(sel.options).map(o => ({ value: o.value, text: o.text.toLowerCase() })) : [];
    });
    let targetValue = null;
    if (searchMode === 'parcel') {
      const m = opts.find(o => o.text.includes('pid') || o.text.includes('parcel') || o.text.includes('mblu'));
      targetValue = m?.value;
    } else {
      const m = opts.find(o => o.text.includes('owner'));
      targetValue = m?.value;
    }
    if (targetValue !== null && targetValue !== undefined) {
      await searchTypeDdl.selectOption({ value: targetValue });
      await page.waitForTimeout(400);
      console.log(`[vision] Selected search-type dropdown option: ${targetValue}`);
    }
  }

  // ── 4. Fill the search fields ────────────────────────────────────────────────
  let filledSelector = null;

  if (searchMode === 'parcel') {
    filledSelector = await tryFill(page, PARCEL_INPUT_SELECTORS, accountNumber);
    if (filledSelector) console.log(`[vision] Filled parcel: ${filledSelector} = ${accountNumber}`);
  } else {
    const last  = fullName ? fullName.split(' ').pop() : lastName;
    const first = fullName ? fullName.split(' ').slice(0, -1).join(' ') : firstName;

    filledSelector = await tryFill(page, LAST_NAME_SELECTORS, last);
    if (filledSelector) {
      console.log(`[vision] Filled last name: ${filledSelector} = ${last}`);
      if (first) await tryFill(page, FIRST_NAME_SELECTORS, first);
    } else {
      const name = fullName || [lastName, firstName].filter(Boolean).join(' ');
      filledSelector = await tryFill(page, SINGLE_OWNER_SELECTORS, name);
      if (filledSelector) console.log(`[vision] Filled single owner field: ${filledSelector} = ${name}`);
    }
  }

  if (!filledSelector) {
    console.log('[vision] Could not find search input — falling back');
    return null;
  }

  // ── 5. Submit the search ─────────────────────────────────────────────────────
  onProgress('Submitting search...');
  const btnSel = await tryClick(page, SEARCH_BTN_SELECTORS);
  if (!btnSel) {
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }
  console.log(`[vision] After submit URL: ${page.url()}`);

  // ── 6. Wait for results ──────────────────────────────────────────────────────
  onProgress('Waiting for results...');
  await waitForGridResults(page);

  const preview = await page.evaluate(() => document.body.innerText.substring(0, 600));
  console.log(`[vision] Results preview:\n${preview}\n---`);

  // ── 7. Extract results table ─────────────────────────────────────────────────
  const tableData = await extractResultsTable(page);
  console.log('[vision] tableData:', JSON.stringify(tableData || null).substring(0, 400));

  if (!tableData || tableData.rows.length === 0) {
    onProgress('No results found.');
    return {
      records: [], totalFound: 0,
      summary: `No records found for ${searchMode === 'parcel' ? 'Parcel ID: ' + accountNumber : 'Owner: ' + (fullName || lastName)}.`,
      searchedUrl: page.url(),
    };
  }

  const { headers, rows } = tableData;
  const MAX_DETAILS_FORM = searchMode === 'parcel' ? rows.length : Math.min(rows.length, 20);
  const cappedRows = rows.slice(0, MAX_DETAILS_FORM);
  onProgress(`Found ${rows.length} result(s). Loading details for first ${cappedRows.length}...`);

  // ── 8. Load detail pages ─────────────────────────────────────────────────────
  const records = [];
  const searchResultsUrl = page.url();
  const originUrl = new URL(page.url()).origin;
  const basePath  = new URL(page.url()).pathname.replace(/\/[^/]*$/, '');

  for (let i = 0; i < cappedRows.length; i++) {
    const { cells, href } = cappedRows[i];
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = cells[idx] || ''; });

    const parcelId   = obj['Parcel ID'] || obj['MBLU'] || obj['Map/Lot'] || cells[0] || '';
    const ownerName  = obj['Owner Name'] || obj['Owner'] || cells[1] || '';
    const address    = obj['Location'] || obj['Address'] || obj['Situs'] || cells[2] || '';
    const totalValue = obj['Total Value'] || obj['Appraised'] || obj['Assessment'] || '';

    const summaryRecord = {
      parcelId, ownerName, propertyAddress: address, taxAmountDue: totalValue,
      legalDescription: obj['Use Code'] || obj['Use'] || obj['Description'] || '',
      taxYear: '', paymentStatus: '', county: '', state: '',
    };

    let detailFields = {};
    try {
      if (href) {
        const detailUrl = href.startsWith('http') ? href
          : href.startsWith('/') ? `${originUrl}${href}`
          : `${originUrl}${basePath}/${href}`;
        onProgress(`Loading property card for ${parcelId || 'record ' + (i + 1)}...`);
        console.log(`[vision] Property card URL: ${detailUrl}`);
        await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForSelector('table tr, h1, h2', { timeout: 10000 }).catch(() => {});
        detailFields = await extractDetailFields(page);
        onProgress(`Extracted ${Object.keys(detailFields).length} fields.`);
      }
    } catch (err) {
      console.log(`[vision] Detail error for ${parcelId}: ${err.message}`);
    }

    records.push({
      ...summaryRecord,
      ownerName:        detailFields['Owner Name']  || detailFields['Owner']           || summaryRecord.ownerName,
      propertyAddress:  detailFields['Location']    || detailFields['Property Address'] || detailFields['Situs Address'] || summaryRecord.propertyAddress,
      legalDescription: detailFields['Use Code']    || detailFields['Description']     || detailFields['Use']           || summaryRecord.legalDescription,
      taxAmountDue:     detailFields['Total Value'] || detailFields['Appraised Value'] || detailFields['Total Assessment'] || summaryRecord.taxAmountDue,
      additionalDetails: JSON.stringify({ ...obj, ...detailFields }),
    });

    if (i < cappedRows.length - 1) {
      try {
        await page.goto(searchResultsUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await waitForGridResults(page);
      } catch (_) {}
    }
  }

  const labelFb    = searchMode === 'parcel' ? `Parcel ID ${accountNumber}` : (fullName || lastName);
  const totalStrFb = rows.length > cappedRows.length
    ? `${rows.length} total, showing first ${records.length}`
    : `${records.length}`;

  return {
    records,
    totalFound: rows.length,
    summary: `Found ${totalStrFb} record(s) for ${labelFb} (Vision Government Solutions).`,
    searchedUrl: searchResultsUrl,
  };
}

module.exports = { search };
