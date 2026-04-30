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
// Navigates to /property-detail/{pid}/{year} and extracts deep data tables

async function extractPropertyDetail(page, pid, year, origin) {
  const detailUrl = `${origin}/property-detail/${pid}/${year}`;
  console.log(`[publicportal] navigating to detail: ${detailUrl}`);
  try {
    await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (_) {
    try { await page.goto(detailUrl, { waitUntil: 'load', timeout: 20000 }); } catch (_2) {}
  }
  await page.waitForTimeout(2500);

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

    // AG Grids (primary on this React SPA)
    for (const grid of Array.from(document.querySelectorAll('.ag-root-wrapper'))) {
      const data = extractAgGrid(grid);
      if (!data || data.length < 2) continue;
      const hStr = data[0].join('|').toLowerCase();
      if (!result.valueHistory && /year|land|improvement|appraised/.test(hStr)) {
        result.valueHistory = data;
      } else if (!result.taxingUnits && /entity|taxable/.test(hStr)) {
        result.taxingUnits = data;
      } else if (!result.deedHistory && /deed|grantor|grantee|instrument/.test(hStr)) {
        result.deedHistory = data;
      } else if (!result.landData && /land.*type|land.*class|use.*code|acre|sqft/.test(hStr)) {
        result.landData = data;
      } else if (!result.improvementData && /improvement|imprv|section/.test(hStr)) {
        result.improvementData = data;
      }
    }

    // HTML tables fallback
    for (const tbl of Array.from(document.querySelectorAll('table'))) {
      const data = extractRegularTable(tbl);
      if (!data) continue;
      const hStr = (data[0] || []).join('|').toLowerCase();
      if (!result.valueHistory && /year|land|improvement|appraised/.test(hStr)) {
        result.valueHistory = data;
      } else if (!result.taxingUnits && /entity|taxable/.test(hStr)) {
        result.taxingUnits = data;
      } else if (!result.deedHistory && /deed|grantor|grantee|instrument/.test(hStr)) {
        result.deedHistory = data;
      } else if (!result.landData && /acre|sqft|land.*type/.test(hStr)) {
        result.landData = data;
      }
    }

    // Key-value fields from page text
    const bodyText = (document.body.innerText || '').replace(/\s{2,}/g, ' ');

    const ownerM = bodyText.match(/Owner(?:\s*Name)?\s*[:\s]\s*([A-Z][A-Z\s&%'.,-]{3,60}?)(?:\s{2,}|\s+(?:GEO|Type|Address|Legal|Acct))/);
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
    console.log(`[publicportal] detail extract error: ${err.message}`);
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

      // For account-number searches, drill into the property detail page for deep data
      if (searchMode === 'account' && records.length > 0) {
        try {
          const firstItem = items[0];
          const pid  = String(firstItem.pid  || records[0].parcelId || '');
          const year = String(firstItem.pYear || new Date().getFullYear());
          if (pid) {
            onProgress('Loading property detail page...');
            const origin = new URL(searchResultsUrl).origin;
            const detail = await extractPropertyDetail(page, pid, year, origin);
            if (detail && Object.keys(detail).length > 1) {
              const existingDetails = JSON.parse(records[0].additionalDetails || '{}');
              records[0].additionalDetails = JSON.stringify({
                ...existingDetails,
                valueHistory:     detail.valueHistory     || null,
                taxingUnits:      detail.taxingUnits      || null,
                landData:         detail.landData         || null,
                improvementData:  detail.improvementData  || null,
                deedHistory:      detail.deedHistory      || null,
                netAppraisedValue: detail.netAppraisedValue || '',
                landMarketValue:   detail.landMarketValue   || '',
                improvementValue:  detail.improvementValue  || '',
                detailPageUrl:     detail.detailUrl         || '',
              });
              // Update top-level fields from detail page if richer
              if (detail.ownerName && !records[0].ownerName) records[0].ownerName = detail.ownerName;
              if (detail.geoId)           { const d = JSON.parse(records[0].additionalDetails); d.geoId = detail.geoId; records[0].additionalDetails = JSON.stringify(d); }
            }
          }
        } catch (de) {
          console.log(`[publicportal] detail drill-in error: ${de.message}`);
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
