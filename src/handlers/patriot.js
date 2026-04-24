'use strict';

const { detectCaptcha } = require('../captchaDetector');

/**
 * src/handlers/patriot.js
 *
 * Playwright handler for Patriot Properties (patriotproperties.com) assessment sites.
 * Coverage: MA, NH, CT, ME municipalities.
 *
 * URL patterns:
 *   - https://www.patriotproperties.com/{TOWN}/default.asp
 *   - https://www.patriotproperties.com/{TOWN}/Parcel.asp?...
 *
 * The interface is classic ASP — a single-page multi-tab form with sections for
 * Owner Name, Property Address, and Map/Parcel searches. Clicking the search type
 * radio button or tab shows the relevant input fields.
 *
 * Search form quirks:
 *   - Owner search uses separate Last / First Name fields
 *   - Parcel search typically uses Map, Lot, Sub fields or a combined MapLot input
 *   - Some deployments have a single "Owner Name" text box instead of split fields
 *   - Results table row links go to `Parcel.asp?pid={ID}` or `Assessment.asp?pid={ID}`
 */

// ─── Selectors ────────────────────────────────────────────────────────────────

// Owner-search tab / radio activators
const OWNER_TAB_SELECTORS = [
  'a:has-text("Owner Name")',
  'a:has-text("By Owner")',
  'input[type="radio"][value*="Owner" i]',
  'input[type="radio"][id*="Owner" i]',
  'label:has-text("Owner Name") input[type="radio"]',
  'td:has-text("Owner Name") input[type="radio"]',
  'a:has-text("Name")',
];

// Parcel/Map search tab activators
const PARCEL_TAB_SELECTORS = [
  'a:has-text("Map/Parcel")',
  'a:has-text("Parcel")',
  'a:has-text("Map Lot")',
  'input[type="radio"][value*="Parcel" i]',
  'input[type="radio"][id*="Parcel" i]',
  'input[type="radio"][value*="Map" i]',
];

// Owner Last Name field
const LAST_NAME_SELECTORS = [
  'input[name="LastName"]',
  'input[name="OwnerLastName"]',
  'input[id*="LastName" i]',
  'input[id*="last_name" i]',
  'input[placeholder*="Last Name" i]',
  'input[name*="Last" i]',
];

// Owner First Name field
const FIRST_NAME_SELECTORS = [
  'input[name="FirstName"]',
  'input[name="OwnerFirstName"]',
  'input[id*="FirstName" i]',
  'input[placeholder*="First Name" i]',
  'input[name*="First" i]',
];

// Single owner-name field (some deployments collapse to one box)
// SearchOwner: classic ASP frameset deployments (e.g. burlington.patriotproperties.com)
const SINGLE_OWNER_SELECTORS = [
  'input[name="SearchOwner"]',
  'input[name="OwnerName"]',
  'input[id*="OwnerName" i]',
  'input[placeholder*="Owner" i]',
  'input[name="Name"]',
];

// Parcel / Map-Lot combined input
// SearchParcel: classic ASP frameset deployments
const PARCEL_INPUT_SELECTORS = [
  'input[name="SearchParcel"]',
  'input[name="MapLot"]',
  'input[name="ParcelID"]',
  'input[name="Parcel"]',
  'input[id*="MapLot" i]',
  'input[id*="ParcelID" i]',
  'input[placeholder*="Parcel" i]',
  'input[placeholder*="Map" i]',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tryClick(page, selectors, timeout = 5000) {
  if (typeof selectors === 'string') selectors = [selectors];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.click({ timeout });
        await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
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

async function clickSearch(page) {
  const btns = [
    'input[type="submit"][value*="Search" i]',
    'button:has-text("Search")',
    'input[type="submit"][value="Go"]',
    'input[name="cmdGo"]',
    'input[type="submit"]',
    'a:has-text("Search")',
    'input[type="button"][value*="Search" i]',
  ];
  for (const sel of btns) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.click({ timeout: 5000 });
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        return sel;
      }
    } catch (_) {}
  }
  if (page.keyboard) {
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }
  return 'Enter';
}

async function isSearchPage(page) {
  return page.evaluate(() => {
    // Accept any visible text-entry input (not hidden/radio/checkbox/submit)
    const inputs = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])' +
      ':not([type="submit"]):not([type="button"]):not([type="image"])'
    );
    return inputs.length > 0;
  });
}

/**
 * Older Patriot deployments use an HTML frameset. The outer page has no inputs —
 * the search form lives inside search-middle.asp and results load into home-bottom.asp.
 * Returns Playwright Frame objects so we can interact with each frame in-context
 * rather than navigating away from the frameset (which breaks cross-frame form targeting).
 */
async function detectFrames(page) {
  const hasFrameset = await page.evaluate(
    () => !!document.querySelector('frameset')
  ).catch(() => false);
  if (!hasFrameset) return { isFrameset: false, searchFrame: null, bottomFrame: null };

  // Give frames time to load
  await page.waitForTimeout(1500);

  const allFrames = page.frames();
  console.log(`[patriot] Frameset — frames: ${allFrames.map(f => f.url()).join(' | ')}`);

  const searchFrame = allFrames.find(f => /search-middle/i.test(f.url()))
    || allFrames.find(f => /search/i.test(f.url()) && f !== page.mainFrame());
  const bottomFrame = allFrames.find(f => /home-bottom/i.test(f.url()))
    || allFrames.find(f => /bottom/i.test(f.url()) && f !== page.mainFrame());

  return {
    isFrameset: true,
    searchFrame: searchFrame || null,
    bottomFrame: bottomFrame || null,
  };
}

async function acceptDisclaimer(page) {
  const selectors = [
    'input[type="submit"][value*="Accept" i]',
    'input[type="submit"][value*="I Agree" i]',
    'a:has-text("Accept")',
    'a:has-text("I Agree")',
    'button:has-text("Accept")',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.click({ timeout: 5000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        console.log(`[patriot] Accepted disclaimer via: ${sel}`);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function waitForResults(page) {
  try {
    await page.waitForSelector('table tr td a, .SearchResults tr, #results tr', { timeout: 12000 });
  } catch (_) {
    await page.waitForTimeout(2000);
  }
}

async function extractResultsTable(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    // Pick the table with the most data rows that contains links (property rows)
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

    const headers = Array.from(allRows[0].querySelectorAll('th, td'))
      .map(el => el.innerText.trim());

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

    document.querySelectorAll('dt').forEach(dt => {
      const dd = dt.nextElementSibling;
      if (dd?.tagName === 'DD') {
        const label = dt.innerText.trim().replace(/:$/, '');
        if (label) data[label] = dd.innerText.trim();
      }
    });

    // Patriot-specific: span labels next to values
    document.querySelectorAll('span[id*="Label"], span[class*="label" i]').forEach(span => {
      const label = span.innerText.trim().replace(/:$/, '');
      const value = span.nextSibling?.textContent?.trim() ||
                    span.nextElementSibling?.innerText?.trim() || '';
      if (label && value) data[label] = value;
    });

    return data;
  });
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page  - Already navigated to Patriot URL
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
  onProgress(`Patriot Properties handler: searching by ${searchMode === 'parcel' ? 'Parcel ID' : 'Owner Name'}...`);
  console.log(`[patriot] mode=${searchMode} startUrl=${page.url()}`);

  // ── 0. CAPTCHA / bot-challenge check ──────────────────────────────────────
  const captcha = await detectCaptcha(page);
  if (captcha.detected) {
    onProgress(`CAPTCHA detected (${captcha.type}) — cannot proceed automatically.`);
    return { ...captcha, searchedUrl: page.url() };
  }

  // ── 1. Handle disclaimer page if present ────────────────────────────────────
  const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
  if (bodyText.includes('disclaimer') || bodyText.includes('i accept') || bodyText.includes('i agree')) {
    onProgress('Accepting disclaimer...');
    await acceptDisclaimer(page);
  }

  // ── 1b. Handle frameset (older Patriot deployments) ─────────────────────────
  // Results load into home-bottom.asp — use Playwright frame API rather than
  // navigating to the search frame directly (which breaks the form's cross-frame target).
  let searchCtx = page;   // Page or Frame used for form interaction
  let isFrameset = false;
  let framesetBottomFrame = null;

  {
    const { isFrameset: fs, searchFrame, bottomFrame } = await detectFrames(page);
    if (fs && searchFrame) {
      isFrameset = true;
      searchCtx = searchFrame;
      framesetBottomFrame = bottomFrame;
      console.log(`[patriot] Search frame: ${searchFrame.url()}`);
      if (bottomFrame) console.log(`[patriot] Bottom frame: ${bottomFrame.url()}`);
    } else if (!fs) {
      // Not a frameset — check for disclaimer / navigate to default.asp if needed
    }
  }

  // ── 2. Verify we have a search form ─────────────────────────────────────────
  let onSearch = await isSearchPage(searchCtx);
  if (!onSearch && !isFrameset) {
    // Try navigating to default.asp (non-frameset deployment with no inputs on landing page)
    const base = new URL(page.url());
    const defaultUrl = `${base.origin}${base.pathname.replace(/\/[^/]*$/, '/default.asp')}`;
    try {
      console.log(`[patriot] No inputs found — trying ${defaultUrl}`);
      await page.goto(defaultUrl, { waitUntil: 'networkidle', timeout: 30000 });
      // Re-detect after navigation
      const { isFrameset: fs2, searchFrame: sf2, bottomFrame: bf2 } = await detectFrames(page);
      if (fs2 && sf2) {
        isFrameset = true;
        searchCtx = sf2;
        framesetBottomFrame = bf2;
      }
      const body2 = await page.evaluate(() => document.body.innerText.toLowerCase());
      if (body2.includes('disclaimer') || body2.includes('i accept')) {
        await acceptDisclaimer(page);
      }
      onSearch = await isSearchPage(searchCtx);
    } catch (e) {
      console.log(`[patriot] Could not reach default.asp — falling back`);
      return null;
    }
  }
  if (!onSearch) {
    console.log('[patriot] No search form found after all attempts — falling back');
    return null;
  }

  // ── 3. Activate the correct search tab / radio ───────────────────────────────
  if (searchMode === 'parcel') {
    const clicked = await tryClick(searchCtx, PARCEL_TAB_SELECTORS);
    if (clicked) console.log(`[patriot] Activated parcel tab via: ${clicked}`);
  } else {
    const clicked = await tryClick(searchCtx, OWNER_TAB_SELECTORS);
    if (clicked) console.log(`[patriot] Activated owner tab via: ${clicked}`);
  }

  // ── 4. Fill the search fields ────────────────────────────────────────────────
  let filledSelector = null;

  if (searchMode === 'parcel') {
    filledSelector = await tryFill(searchCtx, PARCEL_INPUT_SELECTORS, accountNumber);
    if (filledSelector) console.log(`[patriot] Filled parcel: ${filledSelector}`);
  } else {
    // Try split Last / First fields first
    const last = fullName ? fullName.split(' ').pop() : lastName;
    const first = fullName ? fullName.split(' ').slice(0, -1).join(' ') : firstName;

    filledSelector = await tryFill(searchCtx, LAST_NAME_SELECTORS, last);
    if (filledSelector) {
      console.log(`[patriot] Filled last name: ${filledSelector} = ${last}`);
      if (first) await tryFill(searchCtx, FIRST_NAME_SELECTORS, first);
    } else {
      // Fall back to single owner name field
      const name = fullName || [lastName, firstName].filter(Boolean).join(' ');
      filledSelector = await tryFill(searchCtx, SINGLE_OWNER_SELECTORS, name);
      if (filledSelector) console.log(`[patriot] Filled single owner field: ${filledSelector} = ${name}`);
    }
  }

  if (!filledSelector) {
    console.log('[patriot] Could not find any search input — falling back');
    return null;
  }

  // ── 5. Submit the search ─────────────────────────────────────────────────────
  onProgress('Submitting search...');
  const submitted = await clickSearch(searchCtx);
  console.log(`[patriot] Submitted via: ${submitted}`);

  // ── 6. Wait for results ──────────────────────────────────────────────────────
  onProgress('Waiting for results...');

  // In frameset mode the form targets home-bottom.asp — wait for that frame to navigate,
  // then pull the main page onto the results URL so all subsequent work uses page directly.
  let searchResultsUrl;
  if (isFrameset) {
    await page.waitForTimeout(3000);
    // Re-fetch bottom frame (its URL should have changed after search submission)
    const updatedFrames = page.frames();
    const newBottom = updatedFrames.find(f => /home-bottom/i.test(f.url()) && f !== page.mainFrame())
      || updatedFrames.find(f => {
        const u = f.url();
        return f !== page.mainFrame() && u !== page.url() && !/home-top|search-middle/i.test(u);
      });
    const resultsFrameUrl = newBottom?.url() || framesetBottomFrame?.url();
    console.log(`[patriot] Bottom frame URL after submit: ${resultsFrameUrl}`);
    if (resultsFrameUrl && resultsFrameUrl !== 'about:blank') {
      await page.goto(resultsFrameUrl, { waitUntil: 'networkidle', timeout: 30000 });
    }
    searchResultsUrl = page.url();
  } else {
    searchResultsUrl = page.url();
  }

  await waitForResults(page);

  const preview = await page.evaluate(() => document.body.innerText.substring(0, 600));
  console.log(`[patriot] Results preview:\n${preview}\n---`);

  // ── 7. Extract results table ─────────────────────────────────────────────────
  const tableData = await extractResultsTable(page);
  console.log('[patriot] tableData:', JSON.stringify(tableData || null).substring(0, 400));

  if (!tableData || tableData.rows.length === 0) {
    onProgress('No results found.');
    return {
      records: [], totalFound: 0,
      summary: `No records found for ${searchMode === 'parcel' ? 'Parcel ID: ' + accountNumber : 'Owner: ' + (fullName || lastName)}.`,
      searchedUrl: searchResultsUrl,
    };
  }

  const { headers, rows } = tableData;
  const MAX_DETAILS = searchMode === 'parcel' ? rows.length : Math.min(rows.length, 20);
  const cappedRows  = rows.slice(0, MAX_DETAILS);
  onProgress(`Found ${rows.length} result(s). Loading details for first ${cappedRows.length}...`);

  // ── 8. Load detail pages ─────────────────────────────────────────────────────
  const records = [];
  const baseUrl  = new URL(searchResultsUrl).origin;
  const basePath = new URL(searchResultsUrl).pathname.replace(/\/[^/]*$/, '');

  for (let i = 0; i < cappedRows.length; i++) {
    const { cells, href } = cappedRows[i];
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = cells[idx] || ''; });

    // Patriot columns vary but common patterns:
    const parcelId   = obj['Parcel ID'] || obj['Map/Lot/Sub'] || obj['Map-Lot'] || obj['Parcel'] || cells[0] || '';
    const ownerName  = obj['Owner Name'] || obj['Owner']       || cells[1] || '';
    const address    = obj['Location']   || obj['Address']     || obj['Property Address'] || cells[2] || '';
    const totalValue = obj['Total Value'] || obj['Appraised']  || obj['Assessment']       || '';

    const summaryRecord = {
      parcelId, ownerName, propertyAddress: address, taxAmountDue: totalValue,
      legalDescription: obj['Description'] || obj['Use'] || '',
      taxYear: '', paymentStatus: '', county: '', state: '',
    };

    let detailFields = {};
    try {
      if (href) {
        const detailUrl = href.startsWith('http')
          ? href
          : href.startsWith('/')
            ? `${baseUrl}${href}`
            : `${baseUrl}${basePath}/${href}`;
        onProgress(`Loading detail for ${parcelId || 'record ' + (i + 1)}...`);
        console.log(`[patriot] Detail URL: ${detailUrl}`);
        await page.goto(detailUrl, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(1500); // sub-frames need time to load

        // Patriot detail pages (Summary.asp) are framesets — extract from content frames
        const isDetailFrameset = await page.evaluate(() => !!document.querySelector('frameset')).catch(() => false);
        if (isDetailFrameset) {
          const detailFrames = page.frames();
          for (const df of detailFrames) {
            if (df === page.mainFrame()) continue;
            const frameText = await df.evaluate(() => document.body?.innerText?.trim() || '').catch(() => '');
            if (!frameText || frameText.includes('no search has been executed') || frameText.length < 30) continue;
            const frameFields = await extractDetailFields(df);
            console.log(`[patriot] Frame ${df.url().split('/').pop()} → ${Object.keys(frameFields).length} fields`);
            Object.assign(detailFields, frameFields);
          }
        } else {
          await page.waitForSelector('table tr, .detail, h1', { timeout: 10000 }).catch(() => {});
          detailFields = await extractDetailFields(page);
        }
        console.log(`[patriot] Detail total fields (${Object.keys(detailFields).length}):`, JSON.stringify(detailFields).substring(0, 400));
        onProgress(`Extracted ${Object.keys(detailFields).length} fields.`);
      }
    } catch (err) {
      console.log(`[patriot] Detail error for ${parcelId}: ${err.message}`);
    }

    records.push({
      ...summaryRecord,
      ownerName:        detailFields['Owner Name']       || detailFields['Owner']            || summaryRecord.ownerName,
      propertyAddress:  detailFields['Location']         || detailFields['Property Address'] || detailFields['Situs Address'] || summaryRecord.propertyAddress,
      legalDescription: detailFields['Use']              || detailFields['Description']      || detailFields['Legal']         || summaryRecord.legalDescription,
      taxAmountDue:     detailFields['Total Value']      || detailFields['Appraised Value']  || detailFields['Total Assessment'] || summaryRecord.taxAmountDue,
      additionalDetails: JSON.stringify({ ...obj, ...detailFields }),
    });

    if (i < cappedRows.length - 1) {
      try {
        await page.goto(searchResultsUrl, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(500);
      } catch (_) {}
    }
  }

  const label    = searchMode === 'parcel' ? `Parcel ID ${accountNumber}` : (fullName || lastName);
  const totalStr = rows.length > cappedRows.length
    ? `${rows.length} total, showing first ${records.length}`
    : String(records.length);

  return {
    records,
    totalFound: rows.length,
    summary: `Found ${totalStr} record(s) for ${label} (Patriot Properties).`,
    searchedUrl: searchResultsUrl,
  };
}

module.exports = { search };
