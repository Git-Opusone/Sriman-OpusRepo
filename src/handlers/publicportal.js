'use strict';

const { detectCaptcha } = require('../captchaDetector');

/**
 * src/handlers/publicportal.js
 *
 * Playwright handler for the "Public Portal" county CAD search platform.
 * Platform: Aumentum Technologies (TrueProdigy API backend).
 *
 * Known Texas counties: andersoncad.net, harrisoncad.net, somervellcad.net,
 *   tylercad.net, woodcad.net (and others with same Public Portal SPA)
 *
 * Search API: https://prod-container.trueprodigyapi.com/public/property/searchfulltext
 *   POST body: { searchQuery: "...", searchType: "...", year: "2026", page: 1, pageSize: 20 }
 *   Response:  { totalProperty: { propertyCount: N }, results: [...] }
 *
 * Grid: AG Grid (aria-grid), columns:
 *   SEQ | Year | PropID | Type | GEO ID | Ref ID | Tax Office ID | Owner Name | ARB Hearing | DBA | Property Address
 *
 * Note: Detail pages at /property/{pid} are also SPAs — no static fields extractable.
 *   All needed data (owner, address, GEO ID, Ref ID) is in the search API response and grid.
 */

const RESULT_HEADER_KEYWORDS = ['propid', 'prop id', 'owner', 'owner name', 'geo id', 'ref id', 'tax office', 'address'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function ensureSearchPage(page) {
  const url = page.url();
  if (!url.includes('property-search') && !url.includes('property_search')) {
    const base = new URL(url).origin;
    try {
      await page.goto(`${base}/property-search`, { waitUntil: 'networkidle', timeout: 30000 });
    } catch (_) {}
  }
  try {
    await page.waitForSelector('input[placeholder]', { timeout: 20000 });
    await page.waitForTimeout(800);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Fill the search input using React-compatible interaction.
 * el.type() fires real keyboard events that trigger React's onChange.
 */
async function fillSearchInput(page, value) {
  const selectors = [
    'input[placeholder*="search" i]',
    'input[placeholder*="owner" i]',
    'input[placeholder*="name" i]',
    'input[placeholder*="account" i]',
    'input[placeholder*="address" i]',
    'input[type="search"]',
    'input[type="text"]',
  ];

  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.click({ timeout: 5000 });
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await el.type(value, { delay: 40 });
        const actual = await el.inputValue().catch(() => '');
        if (actual.length > 0) {
          console.log(`[publicportal] Filled: ${sel} = "${actual}"`);
          return el;
        }
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Submit by pressing Enter on the focused input.
 * Enter key on the text input is the reliable trigger for this React SPA.
 */
async function submitSearch(page, inputEl) {
  // Press Enter while input is focused
  if (inputEl) {
    try {
      await inputEl.press('Enter');
      console.log('[publicportal] Pressed Enter on input');
      return 'Enter';
    } catch (_) {}
  }
  await page.keyboard.press('Enter');
  console.log('[publicportal] Pressed Enter (fallback)');
  return 'Enter-fallback';
}

/**
 * Poll for the AG Grid to populate with result rows.
 * Returns { rowCount, empty } after up to maxSeconds.
 */
async function waitForGridRows(page, maxSeconds = 12) {
  for (let i = 0; i < maxSeconds; i++) {
    await page.waitForTimeout(1000);
    const state = await page.evaluate(() => {
      const agRows = document.querySelectorAll('.ag-row:not(.ag-row-loading)').length;
      const tableRows = document.querySelectorAll('table tbody tr').length;
      const emptyText = document.body.innerText.toLowerCase();
      const isEmpty = emptyText.includes('no rows to show') || emptyText.includes('no results');
      return { rowCount: agRows + tableRows, isEmpty };
    });
    if (state.rowCount > 0) {
      console.log(`[publicportal] Grid populated after ${i + 1}s: ${state.rowCount} rows`);
      return { rowCount: state.rowCount, empty: false };
    }
    if (state.isEmpty && i >= 4) {
      console.log(`[publicportal] Grid confirmed empty after ${i + 1}s`);
      return { rowCount: 0, empty: true };
    }
  }
  return { rowCount: 0, empty: true };
}

/**
 * Extract rows from the AG Grid ARIA structure.
 * AG Grid uses role="row" + role="gridcell" with aria-colindex attributes.
 */
async function extractGridRows(page) {
  return page.evaluate((headerKeywords) => {
    // ── AG Grid with CSS classes ──────────────────────────────────────────────
    const agHeaderCells = Array.from(document.querySelectorAll('.ag-header-cell'));
    if (agHeaderCells.length > 0) {
      const headers = agHeaderCells
        .map(el => el.querySelector('.ag-header-cell-text')?.innerText?.trim() || el.innerText.trim())
        .filter(h => h.length > 0 && !h.match(/^[▲▼]*$/));

      const agRows = Array.from(document.querySelectorAll('.ag-row:not(.ag-row-loading)'))
        .sort((a, b) => Number(a.getAttribute('row-index') || 0) - Number(b.getAttribute('row-index') || 0));

      if (agRows.length > 0) {
        const rows = agRows.map(row => {
          const cells = Array.from(row.querySelectorAll('.ag-cell'))
            .sort((a, b) => Number(a.getAttribute('aria-colindex') || 0) - Number(b.getAttribute('aria-colindex') || 0))
            .map(el => el.innerText.trim());
          const linkEl = row.querySelector('a[href]');
          return { cells, href: linkEl?.getAttribute('href') || null };
        }).filter(r => r.cells.some(c => c.length > 0));

        if (rows.length > 0) return { headers, rows, layout: 'ag-css' };
      }
    }

    // ── ARIA grid fallback (role="row" + role="gridcell") ─────────────────────
    const ariaRows = Array.from(document.querySelectorAll('[role="row"][aria-rowindex]'))
      .sort((a, b) => Number(a.getAttribute('aria-rowindex')) - Number(b.getAttribute('aria-rowindex')));

    if (ariaRows.length >= 2) {
      const headerRow = ariaRows[0];
      const headers = Array.from(headerRow.querySelectorAll('[role="columnheader"]'))
        .map(el => el.innerText.trim().replace(/[▲▼\s]+$/, '').trim());
      const rows = ariaRows.slice(1).map(row => {
        const cells = Array.from(row.querySelectorAll('[role="gridcell"]'))
          .map(el => el.innerText.trim());
        const linkEl = row.querySelector('a[href]');
        return { cells, href: linkEl?.getAttribute('href') || null };
      }).filter(r => r.cells.some(c => c.length > 0));
      if (rows.length > 0) return { headers, rows, layout: 'ag-aria' };
    }

    // ── HTML <table> fallback ─────────────────────────────────────────────────
    const tables = Array.from(document.querySelectorAll('table'));
    for (const t of tables) {
      const allRows = Array.from(t.querySelectorAll('tr'));
      if (allRows.length < 2) continue;
      const headerCells = Array.from(allRows[0].querySelectorAll('th, td'))
        .map(el => el.innerText.trim().toLowerCase());
      const matches = headerKeywords.filter(k => headerCells.some(c => c.includes(k))).length;
      if (matches < 2) continue;
      const headers = Array.from(allRows[0].querySelectorAll('th, td')).map(el => el.innerText.trim());
      const rows = allRows.slice(1).map(row => {
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
        const linkEl = row.querySelector('td a[href]');
        return { cells, href: linkEl?.getAttribute('href') || null };
      }).filter(r => r.cells.some(c => c.length > 0));
      if (rows.length > 0) return { headers, rows, layout: 'html-table' };
    }

    return null;
  }, RESULT_HEADER_KEYWORDS);
}

/**
 * Map TrueProdigy API item fields to our standard record shape.
 * Field names from live API (andersoncad.net):
 *   pid, pYear, propType, geoID, refID1, taxOfficeRef, name/displayName,
 *   legalDescription, appraisedValue, marketValue, streetPrimary, fullSitus,
 *   addrDeliveryLine, addrCity, addrState, addrZip, dba, arbHearing
 */
function mapApiItem(item) {
  // Situs (property location) address
  const situsStreet = item.streetPrimary ||
    (item.fullSitus || '').replace(/,\s*,.*/, '').trim() || '';
  const situsCity  = item.city  || item.addrCity  || '';
  const situsState = item.state || item.addrState || '';
  const situsZip   = (item.zip  || '').trim() || item.addrZip || '';
  const addressParts = [situsStreet, situsCity, situsState, situsZip]
    .map(p => (p || '').trim()).filter(Boolean);
  const propertyAddress = addressParts.join(', ');

  const apprVal = item.appraisedValue;
  const taxAmountDue = apprVal != null
    ? `$${Number(apprVal).toLocaleString()}`
    : (item.marketValue != null ? `$${Number(item.marketValue).toLocaleString()}` : '');

  return {
    parcelId:         String(item.pid || ''),
    ownerName:        item.name || item.displayName || '',
    propertyAddress,
    legalDescription: item.legalDescription || '',
    taxAmountDue,
    taxYear:          String(item.pYear || ''),
    paymentStatus:    '',
    county:           '',
    state:            item.addrState || '',
    additionalDetails: JSON.stringify({
      propId:         item.pid,
      geoId:          item.geoID,
      refId:          item.refID1,
      taxOfficeRef:   item.taxOfficeRef,
      year:           item.pYear,
      type:           item.propType,
      dba:            item.dba    || '',
      arbHearing:     item.arbHearing || '',
      marketValue:    item.marketValue,
      appraisedValue: item.appraisedValue,
      legalAcreage:   item.legalAcreage,
      mailingAddress: [item.addrDeliveryLine, item.addrCity,
        item.addrState, item.addrZip].filter(Boolean).join(', '),
    }),
  };
}

// ─── Property detail page extraction ─────────────────────────────────────────
// Navigates to /property-detail/{pid}/{year}, intercepts TrueProdigy API
// responses for deep data, and falls back to AG Grid DOM extraction.

/**
 * Convert a TrueProdigy API array-of-objects into a 2D table (headers + rows).
 * e.g. [{year:2026, landValue:5000, ...}, ...] → [['Year','Land Value',...], ['2026','5000',...]]
 */
function apiArrayToTable(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const keys = Object.keys(arr[0]);
  if (keys.length === 0) return null;
  const headers = keys.map(k => k.replace(/([A-Z])/g, ' $1').trim()
    .replace(/^./, c => c.toUpperCase()));
  const rows = arr.map(item => keys.map(k => {
    const v = item[k];
    return v == null ? '' : String(v);
  }));
  return [headers, ...rows];
}

/**
 * Classify a top-level array by sniffing the keys of the first item.
 * TrueProdigy fires separate API requests per data section; each response
 * IS the array (not wrapped inside a named property).
 * Returns the matching detail key, or null if unrecognised.
 */
function classifyArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const keys = Object.keys(arr[0]).map(k => k.toLowerCase());
  const has = (...words) => words.some(w => keys.some(k => k.includes(w)));

  if (has('grantor', 'grantee', 'instrument', 'deed', 'transfer', 'filed'))
    return 'deedHistory';
  if (has('entity', 'taxunit', 'levy', 'taxrate', 'taxable') && !has('year'))
    return 'taxingUnits';
  if (has('landtype', 'landclass', 'usecode', 'landdesc') ||
      (has('acreage', 'sqft') && !has('yearbuilt', 'improvement', 'section')))
    return 'landData';
  if (has('yearbuilt', 'stories', 'imprv', 'improvement', 'section', 'structure'))
    return 'improvementData';
  if (has('year') && has('land', 'improvement', 'appraised', 'market', 'value'))
    return 'valueHistory';
  return null;
}

/**
 * Map a TrueProdigy detail API response into our structured detail shape.
 * Handles three layouts:
 *   1. Top-level array (each detail request returns its own array)
 *   2. Wrapped object  { property: {...}, improvements: [...], ... }
 *   3. Flat property record { pid, geoID, improvements: [...], ... }
 */
function mapDetailApiResponse(data) {
  const result = {};

  // ── Layout 1: top-level array ────────────────────────────────────────────
  if (Array.isArray(data)) {
    const key = classifyArray(data);
    if (key) result[key] = apiArrayToTable(data);
    return result;
  }

  // ── Layout 2/3: object — unwrap common envelope shapes ──────────────────
  const prop = data.property || data.propertyDetail || data.result || data;

  // Named sub-arrays inside the object
  const candidates = {
    valueHistory:    ['valueHistory', 'values', 'appraisalHistory', 'valuations', 'history'],
    taxingUnits:     ['taxingUnits', 'taxEntities', 'taxingEntities', 'entities', 'taxUnits', 'taxingUnit'],
    landData:        ['land', 'landDetails', 'landRecords', 'lands', 'landSegments'],
    improvementData: ['improvements', 'improvement', 'improvementDetails', 'structures', 'imprv', 'improvementSegments'],
    deedHistory:     ['deeds', 'deedHistory', 'deedRecords', 'transfers', 'deedTransactions'],
  };

  for (const [key, names] of Object.entries(candidates)) {
    for (const name of names) {
      if (Array.isArray(prop[name]) && prop[name].length > 0) {
        result[key] = apiArrayToTable(prop[name]);
        break;
      }
    }
    // Also check top-level arrays if not found inside prop
    if (!result[key]) {
      for (const name of names) {
        if (Array.isArray(data[name]) && data[name].length > 0) {
          result[key] = apiArrayToTable(data[name]);
          break;
        }
      }
    }
  }

  // Scalar value fields from the primary property record
  // Use nullish coalescing to pick the first non-null/undefined value (preserves numeric 0)
  const pickVal = (...vs) => { for (const v of vs) { if (v != null) return v; } return undefined; };
  const dollar  = v => (v != null && v !== '') ? `$${Number(v).toLocaleString()}` : undefined;
  result.netAppraisedValue = dollar(pickVal(prop.netAppraisedValue, prop.netAppraised,  prop.totalAppraisedValue,  prop.appraisedValue));
  result.landMarketValue   = dollar(pickVal(prop.landMarketValue,   prop.landValue,     prop.landMktVal));
  result.improvementValue  = dollar(pickVal(prop.improvementValue,  prop.improvementMarketValue, prop.imprValue, prop.imprMktVal));
  result.ownerName         = prop.ownerName || prop.name   || prop.displayName   || '';
  result.geoId             = prop.geoID     || prop.geoId  || prop.geo_id        || '';
  result.legalDescription  = prop.legalDescription || prop.legal || '';
  result.legalAcreage      = prop.legalAcreage != null ? String(prop.legalAcreage) : '';
  result.propertyType      = prop.propType  || prop.propertyType || prop.type    || '';
  result.neighborhoodCode  = prop.neighborhoodCode || prop.neighborhood          || '';
  result.stateCode         = prop.stateCode || prop.stateCd || '';

  // Strip undefined/null/empty
  for (const k of Object.keys(result)) {
    if (result[k] == null || result[k] === '') delete result[k];
  }

  return result;
}

async function extractPropertyDetail(page, pid, year, origin) {
  const detailUrl = `${origin}/property-detail/${pid}/${year}`;
  console.log(`[publicportal] navigating to detail: ${detailUrl}`);

  // Capture ALL JSON API responses on the detail page.
  // TrueProdigy fires several per section: the main prod-container.trueprodigyapi.com
  // domain AND same-origin /api/ calls. We skip only the search endpoints already captured.
  const apiCaptures = [];
  const respHandler = async (resp) => {
    if (resp.status() !== 200) return;
    const url = resp.url();
    const ct  = resp.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    if (/searchfulltext|searchbyname|searchresults/i.test(url)) return;
    // Skip static assets / analytics
    if (/\.(js|css|png|svg|ico|woff|ttf)(\?|$)/i.test(url)) return;
    try {
      const data = await resp.json();
      // Only keep responses that are arrays or plain objects (not empty)
      if (data == null || (typeof data === 'object' && Object.keys(data).length === 0)) return;
      console.log(`[publicportal] detail API: ${url.replace(/^https?:\/\/[^/]+/, '')}`);
      apiCaptures.push({ url, data });
    } catch (_) {}
  };
  page.on('response', respHandler);

  try {
    await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 35000 });
  } catch (_) {
    try { await page.goto(detailUrl, { waitUntil: 'load', timeout: 20000 }); } catch (_2) {}
  }
  // Give the React SPA extra time to fire deferred sub-requests (AG Grid lazy-loads)
  await page.waitForTimeout(5000);

  page.off('response', respHandler);
  console.log(`[publicportal] detail: captured ${apiCaptures.length} API responses`);
  if (apiCaptures.length > 0) {
    apiCaptures.forEach(c => console.log(`  → ${c.url.replace(/^https?:\/\/[^/]+/, '')}`));
  }

  // ── Merge all captured API responses ────────────────────────────────────────
  if (apiCaptures.length > 0) {
    const merged = {};
    const tableKeys = ['valueHistory', 'taxingUnits', 'landData', 'improvementData', 'deedHistory'];

    // First pass: find the primary property record (flat object with pid / geoID)
    const primary = apiCaptures.find(c => {
      const d = c.data?.property || c.data?.propertyDetail || c.data?.result || c.data;
      return d && !Array.isArray(d) &&
        (d.pid != null || d.propId != null || d.geoID != null || d.geoId != null);
    });
    if (primary) Object.assign(merged, mapDetailApiResponse(primary.data));

    // Second pass: every response contributes whatever tables it can provide
    for (const cap of apiCaptures) {
      const sub = mapDetailApiResponse(cap.data);
      // Scalars: only fill in if not already set
      for (const k of ['ownerName','geoId','legalDescription','legalAcreage',
                        'netAppraisedValue','landMarketValue','improvementValue',
                        'propertyType','neighborhoodCode','stateCode']) {
        if (!merged[k] && sub[k]) merged[k] = sub[k];
      }
      // Tables: first winner per key
      for (const k of tableKeys) {
        if (!merged[k] && sub[k]) merged[k] = sub[k];
      }
    }

    if (Object.keys(merged).length > 0) {
      merged.detailUrl = page.url();
      return merged;
    }
  }

  // ── DOM fallback: AG Grids + HTML tables ────────────────────────────────────
  console.log('[publicportal] detail: no API data captured — falling back to DOM');
  return page.evaluate(() => {
    function extractRegularTable(tbl) {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      if (rows.length < 2) return null;
      const data = rows.map(r =>
        Array.from(r.querySelectorAll('td,th')).map(c => (c.innerText || '').trim())
      ).filter(r => r.some(c => c.length > 0));
      return data.length >= 2 ? data : null;
    }

    function extractAgGrid(container) {
      const headerEls = Array.from(container.querySelectorAll('.ag-header-cell-text'));
      if (!headerEls.length) return null;
      const headers = headerEls.map(el => el.innerText.trim()).filter(h => h.length > 0);
      const rows = Array.from(container.querySelectorAll('.ag-row:not(.ag-row-loading)'))
        .sort((a, b) => Number(a.getAttribute('row-index') || 0) - Number(b.getAttribute('row-index') || 0))
        .map(row =>
          Array.from(row.querySelectorAll('.ag-cell'))
            .sort((a, b) => Number(a.getAttribute('aria-colindex') || 0) - Number(b.getAttribute('aria-colindex') || 0))
            .map(c => c.innerText.trim())
        ).filter(r => r.some(c => c.length > 0));
      return rows.length > 0 ? [headers, ...rows] : null;
    }

    const result = {};

    for (const grid of Array.from(document.querySelectorAll('.ag-root-wrapper'))) {
      const data = extractAgGrid(grid);
      if (!data || data.length < 2) continue;
      const hStr = data[0].join('|').toLowerCase();
      if (!result.valueHistory    && /year|land|improvement|appraised/.test(hStr)) result.valueHistory = data;
      else if (!result.taxingUnits     && /entity|taxable/.test(hStr))              result.taxingUnits = data;
      else if (!result.deedHistory     && /deed|grantor|grantee|instrument/.test(hStr)) result.deedHistory = data;
      else if (!result.landData        && /land.*type|land.*class|use.*code|acre|sqft/.test(hStr)) result.landData = data;
      else if (!result.improvementData && /improvement|imprv|section/.test(hStr))   result.improvementData = data;
    }

    for (const tbl of Array.from(document.querySelectorAll('table'))) {
      const data = extractRegularTable(tbl);
      if (!data) continue;
      const hStr = (data[0] || []).join('|').toLowerCase();
      if (!result.valueHistory && /year|land|improvement|appraised/.test(hStr))  result.valueHistory = data;
      else if (!result.taxingUnits && /entity|taxable/.test(hStr))                result.taxingUnits = data;
      else if (!result.deedHistory && /deed|grantor|grantee|instrument/.test(hStr)) result.deedHistory = data;
      else if (!result.landData    && /acre|sqft|land.*type/.test(hStr))           result.landData = data;
    }

    const bodyText = (document.body.innerText || '').replace(/\s{2,}/g, ' ');
    const ownerM   = bodyText.match(/Owner(?:\s*Name)?\s*[:\s]\s*([A-Z][A-Z\s&%'.,-]{3,60}?)(?:\s{2,}|\s+(?:GEO|Type|Address|Legal|Acct))/);
    if (ownerM) result.ownerName = ownerM[1].trim();
    const geoM = bodyText.match(/GEO\s*ID\s*[:\s]*([A-Z0-9/-]{4,30})/i);
    if (geoM) result.geoId = geoM[1].trim();
    const netApprM = bodyText.match(/Net\s*Appraised(?:\s*Value)?\s*\$?\s*([\d,]+)/i);
    if (netApprM) result.netAppraisedValue = `$${netApprM[1]}`;
    const landMktM = bodyText.match(/Land\s*(?:Market\s*)?Value\s*\$?\s*([\d,]+)/i);
    if (landMktM) result.landMarketValue = `$${landMktM[1]}`;
    const imprvM = bodyText.match(/Improvement\s*(?:Market\s*)?Value\s*\$?\s*([\d,]+)/i);
    if (imprvM) result.improvementValue = `$${imprvM[1]}`;

    result.detailUrl = window.location.href;
    return result;
  }).catch(err => {
    console.log(`[publicportal] detail DOM extract error: ${err.message}`);
    return { detailUrl: page.url() };
  });
}

// ─── Main export ─────────────────────────────────────────────────────────────

async function search(page, {
  accountNumber = '',
  firstName = '',
  lastName = '',
  fullName = '',
  onProgress = () => {},
}) {
  const searchMode = accountNumber ? 'account' : 'owner';
  onProgress(`Public Portal handler: searching by ${searchMode === 'account' ? 'Account Number' : 'Owner Name'}...`);
  console.log(`[publicportal] mode=${searchMode} startUrl=${page.url()}`);

  // ── 0. CAPTCHA ───────────────────────────────────────────────────────────────
  const captcha = await detectCaptcha(page);
  if (captcha.detected) {
    onProgress(`CAPTCHA detected (${captcha.type}) — cannot proceed automatically.`);
    return { ...captcha, searchedUrl: page.url() };
  }

  // ── 1. Navigate to search page ───────────────────────────────────────────────
  onProgress('Loading property search page...');
  const ready = await ensureSearchPage(page);
  if (!ready) {
    console.log('[publicportal] Could not reach search form — falling back');
    return null;
  }

  // ── 2. Build search term ─────────────────────────────────────────────────────
  const searchTerm = searchMode === 'account'
    ? accountNumber
    : (fullName || [lastName, firstName].filter(Boolean).join(' '));

  if (!searchTerm) {
    console.log('[publicportal] No search term — falling back');
    return null;
  }

  // ── 3. Fill input ────────────────────────────────────────────────────────────
  const inputEl = await fillSearchInput(page, searchTerm);
  if (!inputEl) {
    console.log('[publicportal] Could not find/fill search input — falling back');
    return null;
  }
  await page.waitForTimeout(200);

  // ── 4. Intercept the TrueProdigy search API response (full JSON, no truncation) ──
  let apiData = null;
  const apiCapture = page.waitForResponse(
    (resp) => resp.status() === 200 && /searchfulltext|searchbyname|searchresults|property.*search/i.test(resp.url()),
    { timeout: 30000 }
  ).then(async (resp) => {
    try {
      const data = await resp.json();
      apiData = data;
      const count = data?.totalProperty?.propertyCount ?? data?.total ?? data?.count ?? '?';
      console.log(`[publicportal] API: ${resp.url()} → total=${count}`);
    } catch (e) {
      console.log(`[publicportal] API parse error: ${e.message}`);
    }
  }).catch((e) => {
    console.log(`[publicportal] API intercept miss: ${e.message?.substring(0, 80)}`);
  });

  // ── 5. Submit ────────────────────────────────────────────────────────────────
  onProgress('Submitting search...');
  await submitSearch(page, inputEl);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  const searchResultsUrl = page.url();

  // ── 6. Wait for grid rows ────────────────────────────────────────────────────
  onProgress('Waiting for results...');
  const { rowCount, empty } = await waitForGridRows(page);
  await apiCapture;

  console.log(`[publicportal] Grid rowCount=${rowCount} empty=${empty}`);

  // ── 7. Use API response if available ─────────────────────────────────────────
  if (apiData) {
    const items = apiData.results || apiData.items || apiData.data ||
                  apiData.properties || apiData.records ||
                  (Array.isArray(apiData) ? apiData : null);

    if (Array.isArray(items)) {
      const totalCount = apiData.totalProperty?.propertyCount ??
                         apiData.totalCount ?? apiData.total ?? apiData.count ?? items.length;
      console.log(`[publicportal] API items=${items.length}, total=${totalCount}`);

      if (items.length === 0) {
        return {
          records: [], totalFound: 0,
          summary: `No records found for ${searchTerm} (Public Portal).`,
          searchedUrl: searchResultsUrl,
        };
      }

      const MAX = searchMode === 'account' ? items.length : Math.min(items.length, 20);
      const records = items.slice(0, MAX).map(mapApiItem);

      // Drill into detail page for every account search and for owner searches
      // that return a small result set (≤5 records) — same as single-match lookups.
      const shouldDrillDetail = searchMode === 'account' || records.length <= 5;
      if (shouldDrillDetail && records.length > 0) {
        const origin = new URL(searchResultsUrl).origin;
        // For owner searches with multiple results, drill each record (up to 5)
        const drillCount = searchMode === 'account' ? records.length : Math.min(records.length, 5);
        for (let i = 0; i < drillCount; i++) {
          try {
            const item = items[i];
            const pid  = String(item.pid  || records[i].parcelId || '');
            const year = String(item.pYear || new Date().getFullYear());
            if (!pid) continue;
            onProgress(`Loading property detail${drillCount > 1 ? ` (${i + 1}/${drillCount})` : ''}...`);
            const detail = await extractPropertyDetail(page, pid, year, origin);
            if (!detail || Object.keys(detail).length <= 1) continue;
            const existingDetails = JSON.parse(records[i].additionalDetails || '{}');
            records[i].additionalDetails = JSON.stringify({
              ...existingDetails,
              valueHistory:      detail.valueHistory      || null,
              taxingUnits:       detail.taxingUnits       || null,
              landData:          detail.landData          || null,
              improvementData:   detail.improvementData   || null,
              deedHistory:       detail.deedHistory       || null,
              netAppraisedValue: detail.netAppraisedValue || '',
              landMarketValue:   detail.landMarketValue   || '',
              improvementValue:  detail.improvementValue  || '',
              legalDescription:  detail.legalDescription  || existingDetails.legalDescription || '',
              legalAcreage:      detail.legalAcreage      || existingDetails.legalAcreage || '',
              detailPageUrl:     detail.detailUrl         || '',
            });
            if (detail.ownerName && !records[i].ownerName) records[i].ownerName = detail.ownerName;
            if (detail.legalDescription && !records[i].legalDescription) records[i].legalDescription = detail.legalDescription;
            if (detail.geoId) {
              const d = JSON.parse(records[i].additionalDetails);
              d.geoId = detail.geoId;
              records[i].additionalDetails = JSON.stringify(d);
            }
          } catch (de) {
            console.log(`[publicportal] detail drill-in error (record ${i}): ${de.message}`);
          }
        }
      }

      const totalStr = totalCount > MAX
        ? `${totalCount} total, showing first ${records.length}`
        : `${records.length}`;

      return {
        records,
        totalFound: totalCount,
        summary: `Found ${totalStr} record(s) for ${searchTerm} (Public Portal).`,
        searchedUrl: searchResultsUrl,
      };
    }
  }

  // ── 8. Fallback: extract from AG Grid DOM ────────────────────────────────────
  if (empty || rowCount === 0) {
    return {
      records: [], totalFound: 0,
      summary: `No records found for ${searchTerm} (Public Portal).`,
      searchedUrl: searchResultsUrl,
    };
  }

  const gridData = await extractGridRows(page);
  console.log(`[publicportal] Grid DOM: ${gridData ? `${gridData.rows.length} rows (${gridData.layout})` : 'null'}`);
  console.log(`[publicportal] Headers: ${gridData?.headers?.join(' | ') || 'n/a'}`);

  if (!gridData || gridData.rows.length === 0) {
    console.log('[publicportal] No grid data — falling back to AI');
    return null;
  }

  const { headers, rows } = gridData;
  const hLower = headers.map(h => h.toLowerCase());

  // Map column indices
  // "PropID" must come before "Property Address" — both contain 'prop'
  const propIdIdx  = hLower.findIndex(h => /^prop\s*id$/i.test(h) || h === 'propid');
  const ownerIdx   = hLower.findIndex(h => h.includes('owner'));
  const addrIdx    = hLower.findIndex(h => h.includes('address') || h.includes('addr'));
  const geoIdIdx   = hLower.findIndex(h => h.includes('geo'));
  const refIdIdx   = hLower.findIndex(h => h.includes('ref') && !h.includes('arb'));
  const yearIdx    = hLower.findIndex(h => h === 'year');
  const typeIdx    = hLower.findIndex(h => h === 'type');

  console.log(`[publicportal] Col indices: propId=${propIdIdx} owner=${ownerIdx} addr=${addrIdx} geo=${geoIdIdx} ref=${refIdIdx}`);

  const origin = new URL(searchResultsUrl).origin;

  const records = rows.map(({ cells, href }) => {
    const propId    = propIdIdx  >= 0 ? cells[propIdIdx]  : cells[2] || '';
    const ownerName = ownerIdx   >= 0 ? cells[ownerIdx]   : '';
    const address   = addrIdx    >= 0 ? cells[addrIdx]    : '';
    const geoId     = geoIdIdx   >= 0 ? cells[geoIdIdx]   : '';
    const refId     = refIdIdx   >= 0 ? cells[refIdIdx]   : '';
    const year      = yearIdx    >= 0 ? cells[yearIdx]    : '';
    const type      = typeIdx    >= 0 ? cells[typeIdx]    : '';

    return {
      parcelId:        propId,
      ownerName,
      propertyAddress: address,
      legalDescription: '',
      taxAmountDue:    '',
      taxYear:         year,
      paymentStatus:   '',
      county:          '',
      state:           '',
      additionalDetails: JSON.stringify({ propId, geoId, refId, year, type }),
    };
  });

  const label    = searchMode === 'account' ? `Account ${accountNumber}` : searchTerm;
  const totalStr = `${records.length} (page 1 of results; ${rowCount} visible rows)`;

  return {
    records,
    totalFound: records.length,
    summary: `Found ${totalStr} record(s) for ${label} (Public Portal).`,
    searchedUrl: searchResultsUrl,
  };
}

module.exports = { search };
