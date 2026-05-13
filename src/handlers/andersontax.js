'use strict';

const { detectCaptcha } = require('../captchaDetector');

const TAX_BASE = 'http://tax.co.anderson.tx.us';

function normalizePropId(id) {
  const s = (id || '').trim();
  return /^r/i.test(s) ? s.toUpperCase() : `R${s}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function hasDisclaimerContent(page) {
  try {
    return await page.evaluate(() => {
      const t = (document.body?.innerText || '').toLowerCase();
      return t.includes('disclaimer') && t.includes('every effort');
    });
  } catch (_) { return false; }
}

async function isDetailPage(page) {
  try {
    return await page.evaluate(() => {
      const t = (document.body?.innerText || '').toLowerCase();
      return (t.includes('total taxes due') || t.includes('current amount due')) &&
             t.includes('property status');
    });
  } catch (_) { return false; }
}

async function tryAcceptDisclaimer(page) {
  const SELECTORS = [
    'input[value*="Accept" i]',
    'button:has-text("Accept")',
    'a:has-text("Accept")',
    'input[value*="Agree" i]',
    'button:has-text("I Agree")',
    'button:has-text("I Accept")',
    'a:has-text("I Agree")',
    'a:has-text("I Accept")',
    'button:has-text("Continue")',
    'a:has-text("Continue")',
    'a.dnnPrimaryAction',
    'input[type="submit"]',
    'button[type="submit"]',
  ];
  for (const sel of SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count({ timeout: 1500 }) > 0 && await btn.isVisible({ timeout: 1500 })) {
        console.log(`[andersontax] disclaimer via: ${sel}`);
        await btn.click({ timeout: 5000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function handleDisclaimerIfPresent(page, tag) {
  if (/disclaimer/i.test(page.url()) || await hasDisclaimerContent(page)) {
    console.log(`[andersontax] disclaimer at ${tag}`);
    await tryAcceptDisclaimer(page);
    await page.waitForTimeout(2000);
  }
}

async function safeGoto(page, url, timeout = 25000) {
  try {
    await page.goto(url, { waitUntil: 'load', timeout });
  } catch (_) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 15000) }); } catch (_2) {}
  }
}

// ─── Extract data from Kendo grid search results ──────────────────────────────
// Uses header-derived column positions to avoid offset bugs from hidden columns

async function extractFromSearchGrid(page, propId) {
  return page.evaluate((pid) => {
    const stripped = pid.replace(/^r/i, '').toUpperCase();
    let ownerName = '', situsAddress = '', assessedValue = '', accountNumber = '', propertyLink = null;
    const currentPath = window.location.pathname;

    const grids = Array.from(document.querySelectorAll('.k-grid, [data-role="grid"]'));
    for (const grid of grids) {
      // Detect column positions from header
      const headerRow = grid.querySelector('thead tr');
      const headers = headerRow
        ? Array.from(headerRow.querySelectorAll('th')).map(th => (th.innerText || '').trim().toLowerCase())
        : [];

      const idxOf = (pred) => { const i = headers.findIndex(pred); return i >= 0 ? i : -1; };
      const pidCol    = idxOf(h => h.includes('property') && h.includes('id'));
      const acctCol   = idxOf(h => h.includes('account') && !h.includes('owner'));
      const ownerCol  = idxOf(h => h.includes('owner') && h.includes('name'));
      const situsCol  = idxOf(h => h.includes('situs') || (h.includes('address') && !h.includes('owner') && !h.includes('mailing')));
      const assCol    = idxOf(h => h.includes('assessed'));

      const rows = Array.from(grid.querySelectorAll('.k-grid-content tbody tr, tbody tr'));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (!cells.length) continue;
        const ct = cells.map(c => (c.innerText || '').trim());

        // Locate property ID cell by value
        const pidCellIdx = ct.findIndex(t => t === pid || t === stripped);
        if (pidCellIdx < 0) continue;

        // Extract with header-derived indices; fall back to offsets from pidCellIdx
        accountNumber = acctCol  >= 0 ? ct[acctCol]  : (ct[pidCellIdx + 1] || '');
        ownerName     = ownerCol >= 0 ? ct[ownerCol] : (ct[pidCellIdx + 2] || '');
        situsAddress  = situsCol >= 0 ? ct[situsCol] : '';

        if (assCol >= 0 && ct[assCol]) {
          const raw = ct[assCol];
          assessedValue = raw.startsWith('$') ? raw : `$${raw.replace(/[^0-9,]/g, '')}`;
        }

        // Find a navigation link that goes to a DIFFERENT page (not an anchor on current page)
        for (const a of Array.from(row.querySelectorAll('a[href]'))) {
          try {
            const u = new URL(a.href);
            if (u.pathname !== currentPath && !u.pathname.toLowerCase().includes('disclaimer')
                && !a.href.includes('javascript:')) {
              propertyLink = a.href;
              break;
            }
          } catch (_) {}
        }
        break;
      }
      if (accountNumber || ownerName) break;
    }

    return { ownerName, situsAddress, assessedValue, accountNumber, propertyLink };
  }, propId).catch(() => ({ ownerName: '', situsAddress: '', assessedValue: '', accountNumber: '', propertyLink: null }));
}

// ─── Extract all fields from the detail page ─────────────────────────────────

async function extractDetailData(page, propId) {
  return page.evaluate((pid) => {
    const rawText = document.body.innerText || '';
    const text    = rawText.replace(/\s+/g, ' ');
    const lines   = rawText.split('\n').map(l => l.trim()).filter(Boolean);
    const stripped = pid.replace(/^r/i, '').toUpperCase();

    // ── DOM-based label:value map (most reliable on Kendo/SPA pages) ──────────
    // Builds { 'legal description': 'A0002 ...', 'effective acres': '12.0000', ... }
    const domMap = {};
    // Scan all table cells: if a cell text looks like a label, use next sibling as value
    Array.from(document.querySelectorAll('td, th')).forEach(el => {
      const lbl = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[:\*]+$/, '').trim();
      if (!lbl || lbl.length > 60 || lbl.length < 3) return;
      const sib = el.nextElementSibling;
      if (sib) {
        const val = (sib.innerText || '').replace(/\s+/g, ' ').trim();
        if (val && val.length < 300) domMap[lbl] = val;
      }
    });
    // Scan definition lists (dt/dd)
    Array.from(document.querySelectorAll('dt')).forEach(dt => {
      const lbl = (dt.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[:\*]+$/, '').trim();
      const dd  = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD') {
        const val = (dd.innerText || '').replace(/\s+/g, ' ').trim();
        if (lbl && val) domMap[lbl] = val;
      }
    });
    // Scan label/span pairs (common in Angular/React detail panels)
    Array.from(document.querySelectorAll('[class*="label"],[class*="field-name"],[class*="detail-label"]')).forEach(el => {
      const lbl = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[:\*]+$/, '').trim();
      const sib = el.nextElementSibling || el.parentElement && el.parentElement.querySelector('[class*="value"],[class*="field-value"]');
      if (sib && lbl && lbl.length < 60) {
        const val = (sib.innerText || '').replace(/\s+/g, ' ').trim();
        if (val && val.length < 300) domMap[lbl] = val;
      }
    });

    // ── Adjacent-line label:value scan ────────────────────────────────────────
    const KNOWN_LABELS = ['property type','property status','owner name','situs address',
      'legal description','legal desc','effective acres','eff acres',
      'land homesite value','land non-homesite value','land market value','land value',
      'improvement homesite value','improvement market value','improvement value',
      'account','assessed value','neighborhood','map number'];
    const lineMap = {};
    for (let i = 0; i < lines.length - 1; i++) {
      const L    = lines[i].trim();
      const lLow = L.toLowerCase().replace(/[:\*]+$/, '').trim();
      if (KNOWN_LABELS.indexOf(lLow) >= 0) {
        // Check inline "Label: Value"
        const colonM = L.match(/^(.+?):\s*(.{2,200})$/);
        if (colonM) {
          lineMap[colonM[1].toLowerCase().trim()] = colonM[2].trim();
        } else {
          // Value is on next line
          const nextL = lines[i + 1].trim();
          if (nextL) lineMap[lLow] = nextL;
        }
      }
    }

    // Merge: DOM takes priority, then lineMap
    const lmap = Object.assign({}, lineMap, domMap);

    // ── Owner name ────────────────────────────────────────────────────────────
    let ownerName = '';
    const ownerM = text.match(/Owner\s*Name\s*([A-Z][A-Z\s&%']{4,60}?)(?:\s*Owner ID|\s*Exemptions|\s*Percent)/);
    if (ownerM) ownerName = ownerM[1].trim();
    if (!ownerName) ownerName = lmap['owner name'] || '';
    if (!ownerName) {
      const SKIP = /DISCLAIMER|COUNTY APPRAISAL|TAX OFFICE|SEARCH|RESULTS|PROPERTY TYPE|PROPERTY STATUS|TAXING|ENTITY|ACCOUNT|ASSESSED|SELECT|COLUMNS|EXPORT/;
      const pidIdx = lines.findIndex(l => l === pid || l === stripped);
      if (pidIdx >= 0) {
        for (let i = pidIdx - 4; i <= pidIdx + 8; i++) {
          if (i < 0 || i >= lines.length) continue;
          const l = lines[i];
          if (/^[A-Z][A-Z\s&%']{4,60}$/.test(l) && !SKIP.test(l) && !/\d/.test(l)) { ownerName = l; break; }
        }
      }
    }

    // ── Situs address ─────────────────────────────────────────────────────────
    let situsAddress = lmap['situs address'] || lmap['situs'] || '';
    if (!situsAddress) {
      const addrM = text.match(/(?:Address|Situs)[:\s]+(\d+\s+(?:AN |)[A-Z][A-Z\s]+(?:ROAD|RD|ST|AVE|HWY|BLVD|DR|LN)[^\n\r]{0,40})/i);
      if (addrM) situsAddress = addrM[1].trim();
    }
    if (!situsAddress) {
      const ROAD_RX = /\b(?:ROAD|RD|STREET|ST|AVENUE|AVE|HWY|HIGHWAY|BLVD|DRIVE|DR|LANE|LN|CO(?:UNTY)?\s*RD?)\b/i;
      for (const l of lines) {
        if (/^\d+/.test(l) && ROAD_RX.test(l) && l.length < 80 && !/PALESTINE|TX|75/i.test(l)) { situsAddress = l; break; }
      }
    }

    // ── Assessed value ────────────────────────────────────────────────────────
    let assessedValue = '';
    const avM = text.match(/CERTIFIED\s*\$?\s*([\d,]+)/i)
             || text.match(/Assessed\s*Value\s*[^$\n]{0,20}\$\s*([\d,]+)/i);
    if (avM) assessedValue = `$${avM[1]}`;
    if (!assessedValue && lmap['assessed value']) {
      const rawAv = lmap['assessed value'].replace(/[^0-9,]/g, '');
      if (rawAv) assessedValue = `$${rawAv}`;
    }

    // ── Account number ────────────────────────────────────────────────────────
    let accountNumber = '';
    const acctM = text.match(/Account\s*[\n\r\s:]*(\d{4}-\d{4}-\d{4}-\d{4})/i)
               || text.match(/(\d{4}-\d{4}-\d{4}-\d{4})/);
    if (acctM) accountNumber = acctM[1];

    // ── Legal description ─────────────────────────────────────────────────────
    let legalDescription = lmap['legal description'] || lmap['legal desc'] || '';
    if (!legalDescription) {
      // Try 1: regex on whitespace-collapsed text — allow any alphanumeric/hash start
      const legalM = text.match(/Legal\s*Desc(?:ription)?\s*:?\s*([A-Za-z0-9#][^\n\r]{5,150}?)(?=\s+(?:Property\s+Status|Property\s+Type|Neighborhood|Account|Map\s*Number|Effective\s*Acres|\d{4}\s+(?:GENERAL|OWNER|CERTIFIED)))/i)
                  || text.match(/Legal\s*Desc(?:ription)?\s*:?\s*([A-Za-z0-9#][^\n\r]{5,150})/i);
      if (legalM) legalDescription = legalM[1].replace(/\s+/g, ' ').trim();
    }
    // Try 2: line scan with boundary detection
    if (!legalDescription) {
      const LBND = /^(Property\s+Status|Property\s+Type|Neighborhood|Account|Map|Effective\s+Acres|\d{4}\s+(GENERAL|OWNER|CERTIFIED)|Value\s+History|Situs|Owner\s+Name|Percent\s+Ownership)/i;
      const lIdx = lines.findIndex(l => /^Legal\s*Desc/i.test(l));
      if (lIdx >= 0) {
        const inline = lines[lIdx].replace(/^Legal\s*Desc(?:ription)?\s*:?\s*/i, '').trim();
        if (inline.length >= 5) {
          legalDescription = inline;
        } else {
          const parts = [];
          for (let i = lIdx + 1; i < Math.min(lIdx + 5, lines.length); i++) {
            if (LBND.test(lines[i])) break;
            parts.push(lines[i]);
          }
          if (parts.length) legalDescription = parts.join(' ').trim();
        }
      }
    }

    // ── Effective acres ───────────────────────────────────────────────────────
    let acres = lmap['effective acres'] || lmap['eff acres'] || lmap['acres'] || '';
    if (!acres) {
      const acresM = text.match(/Effective\s*Acres?\s*:?\s*([\d.]+)/i)
                  || text.match(/\bAcres?\s*:?\s*([\d.]+)/i);
      if (acresM) acres = acresM[1];
    }
    // Fallback: parse from legal description
    if (!acres && legalDescription) {
      const am = legalDescription.match(/([\d.]+)\s*ACRES?/i);
      if (am) acres = am[1];
    }

    // ── Land and improvement values ───────────────────────────────────────────
    let landValue = '', improvementValue = '';

    // Try text regex first
    const lv1 = text.match(/Land\s+Homesite\s+Value\s*:?\s*\$?([\d,]+)/i);
    const lv2 = text.match(/Land\s+Non.Homesite\s+Value\s*:?\s*\$?([\d,]+)/i);
    const lv3 = text.match(/Land\s+(?:Market\s+)?Value\s*:?\s*\$?([\d,]+)/i);
    const rawLand = lv1 ? lv1[1] : lv2 ? lv2[1] : lv3 ? lv3[1] : '';
    if (rawLand) landValue = `$${rawLand.replace(/[^0-9,]/g, '')}`;

    // DOM/line map fallback for land value
    if (!landValue) {
      const rawLv = lmap['land homesite value'] || lmap['land non-homesite value']
                 || lmap['land market value'] || lmap['land value'] || '';
      if (rawLv) landValue = rawLv.startsWith('$') ? rawLv : `$${rawLv.replace(/[^0-9,]/g, '')}`;
    }

    const iv1 = text.match(/Improvement\s+(?:Homesite\s+)?(?:Market\s+)?Value\s*:?\s*\$?([\d,]+)/i);
    if (iv1) improvementValue = `$${iv1[1].replace(/[^0-9,]/g, '')}`;

    if (!improvementValue) {
      const rawIv = lmap['improvement homesite value'] || lmap['improvement market value']
                 || lmap['improvement value'] || '';
      if (rawIv) improvementValue = rawIv.startsWith('$') ? rawIv : `$${rawIv.replace(/[^0-9,]/g, '')}`;
    }

    // ── Property info ─────────────────────────────────────────────────────────
    let propertyStatus = lmap['property status'] || '';
    if (!propertyStatus) {
      const statusM = text.match(/Property\s*Status\s*:?\s*(Active|Inactive|[A-Za-z]+)/i);
      if (statusM) propertyStatus = statusM[1].trim();
    }

    let propertyType = lmap['property type'] || '';
    if (!propertyType) {
      const typeM = text.match(/Property\s*Type\s*:?\s*(Real|Personal|[A-Za-z]+)/i);
      if (typeM) propertyType = typeM[1].trim();
    }

    // Debug log (visible in server stdout via Playwright page.on('console'))
    const dbg = 'legalDesc=' + legalDescription + ' | acres=' + acres + ' | land=' + landValue + ' | impr=' + improvementValue;
    console.log('[andersontax-extract] ' + dbg);

    return { ownerName, situsAddress, assessedValue, accountNumber, legalDescription, acres, landValue, improvementValue, propertyStatus, propertyType };
  }, propId).catch(() => ({ ownerName: '', situsAddress: '', assessedValue: '', accountNumber: '', legalDescription: '', propertyStatus: '', propertyType: '' }));
}

// ─── Extract bill history from the detail page ────────────────────────────────

async function extractBillData(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';

    const grabAmt = (pattern) => {
      const re = new RegExp(pattern + '[\\s\\S]{0,120}?\\$?\\s*([\\d,]+\\.\\d{2})', 'i');
      const m = text.match(re);
      return m ? `$${m[1]}` : '';
    };

    const currentDue = grabAmt('Current Amount Due');
    const pastDue    = grabAmt('Past Years? Due');
    const totalDue   = grabAmt('Total Due');

    // ── Bill tables: ONLY tables with "TAXING ENTITY" header row ─────────────
    // This prevents false-positive matches on Kendo grid column selector tables
    const billTables  = [];
    const yearHeaders = [];

    for (const tbl of Array.from(document.querySelectorAll('table'))) {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      const flat = rows
        .map(r => Array.from(r.querySelectorAll('td, th')).map(c => (c.innerText || '').trim()))
        .filter(r => r.some(c => c.length > 0));

      if (flat.length < 2) continue;

      // STRICT check: must have a header row containing "TAXING" and "ENTITY"
      // AND at least one data row with a dollar amount — prevents Kendo grid false positives
      const hasTaxingEntityHeader = flat.some(r =>
        r.some(c => /TAXING\s*ENTITY/i.test(c))
      );
      const hasDollarAmounts = flat.some(r =>
        r.some(c => /\$\d+\.\d{2}/.test(c))
      );
      if (!hasTaxingEntityHeader || !hasDollarAmounts) continue;

      // Filter out Kendo Grid expansion sub-rows (Levy, P&I, Att.Fee, Credits/Disc.)
      const SUB_ROW_RX = /^(Levy|P&I|Att\.?\s*Fee|Credits\s*\/?\s*Disc|Discount)\b/i;
      const cleanFlat = [
        flat[0], // keep header row
        ...flat.slice(1).filter(r => {
          const first = (r[0] || '').trim();
          if (SUB_ROW_RX.test(first)) return false;
          // skip concatenated single-cell summary row "Levy$40.76P&I$0.00..."
          if (r.filter(c => c.length > 0).length <= 2 && /Levy|P&I/i.test(r.join(''))) return false;
          return true;
        }),
      ];
      billTables.push(cleanFlat);

      // Walk DOM to find adjacent year label (19xx or 20xx)
      let yearLabel = '';
      let el = tbl;
      for (let depth = 0; depth < 8 && !yearLabel; depth++) {
        let sib = el.previousElementSibling;
        while (sib && !yearLabel) {
          const sibT = (sib.innerText || sib.textContent || '').trim();
          const yrM = sibT.match(/\b((?:19|20)\d{2})\b/);
          if (yrM) yearLabel = yrM[1];
          sib = sib.previousElementSibling;
        }
        el = el.parentElement;
        if (!el) break;
      }
      if (!yearLabel) {
        const yrM = (tbl.innerText || '').match(/\b((?:19|20)\d{2})\b/);
        if (yrM) yearLabel = yrM[1];
      }
      yearHeaders.push(yearLabel);
    }

    return { currentDue, pastDue, totalDue, billTables, yearHeaders, detailUrl: window.location.href };
  }).catch(() => ({
    currentDue: '', pastDue: '', totalDue: '',
    billTables: [], yearHeaders: [], detailUrl: page.url(),
  }));
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function search(page, { accountNumber = '', onProgress = () => {} }) {
  if (!accountNumber) return null;

  const propId   = normalizePropId(accountNumber);
  const stripped = propId.replace(/^r/i, '').toUpperCase();
  onProgress(`Anderson County Tax Office: searching ${propId}...`);
  console.log(`[andersontax] propId=${propId}`);

  try {
    const cap = await detectCaptcha(page);
    if (cap.detected) return { ...cap, searchedUrl: page.url() };

    // ── 1. Navigate directly to search URL (no home-page pre-visit) ───────────
    const searchUrl = `${TAX_BASE}/Property-Search-Result/searchtext/${encodeURIComponent(propId)}`;
    onProgress('Loading Tax Office search...');
    await safeGoto(page, searchUrl, 25000);
    await page.waitForTimeout(2000);

    // Accept disclaimer if redirected there
    await handleDisclaimerIfPresent(page, 'search');

    // If disclaimer bounced us to homepage or elsewhere, re-navigate to search
    if (!page.url().includes('Property-Search')) {
      await safeGoto(page, searchUrl, 20000);
      await page.waitForTimeout(2000);
    }

    // ── 2. Wait for Kendo grid and pull search-row data ───────────────────────
    await page.waitForSelector('.k-grid tbody tr, [data-role="grid"] tbody tr',
      { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const basic = await extractFromSearchGrid(page, propId);
    console.log(`[andersontax] grid: owner="${basic.ownerName}" acct="${basic.accountNumber}" link="${basic.propertyLink}"`);

    // ── 3. Navigate to property detail ────────────────────────────────────────
    // Strategy A: try direct URL patterns with SHORT timeouts (10s each)
    const directUrlCandidates = [
      `${TAX_BASE}/Property-Detail/${encodeURIComponent(propId)}`,
      `${TAX_BASE}/Property-Detail/${encodeURIComponent(stripped)}`,
      `${TAX_BASE}/Property/View/${encodeURIComponent(propId)}`,
    ];

    let reachedDetail = false;
    for (const url of directUrlCandidates) {
      onProgress('Checking property detail...');
      await safeGoto(page, url, 12000);
      await page.waitForTimeout(1000);
      await handleDisclaimerIfPresent(page, 'detail-direct');
      if (await isDetailPage(page)) {
        reachedDetail = true;
        console.log(`[andersontax] detail via direct URL: ${page.url()}`);
        break;
      }
    }

    // Strategy B: click the Kendo grid row (navigate back to search first)
    if (!reachedDetail) {
      onProgress('Clicking property row...');
      await safeGoto(page, searchUrl, 20000);
      await page.waitForTimeout(2000);
      await handleDisclaimerIfPresent(page, 'search-b');
      await page.waitForSelector('.k-grid tbody tr, [data-role="grid"] tbody tr',
        { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(1000);

      try {
        const pidCell = page.locator('td').filter({ hasText: new RegExp(`^${propId}$`) }).first();
        if (await pidCell.count({ timeout: 2000 }) > 0) {
          await Promise.all([
            page.waitForNavigation({ timeout: 10000, waitUntil: 'load' }).catch(() => {}),
            pidCell.click({ timeout: 4000 }),
          ]);
          await page.waitForTimeout(1500);
          await handleDisclaimerIfPresent(page, 'after-click');
          reachedDetail = await isDetailPage(page);
          console.log(`[andersontax] after row click: ${page.url()} detail=${reachedDetail}`);
        }
      } catch (ce) {
        console.log(`[andersontax] row click error: ${ce.message}`);
      }
    }

    // Strategy C: use any real grid link found
    if (!reachedDetail && basic.propertyLink) {
      onProgress('Following property link...');
      await safeGoto(page, basic.propertyLink, 15000);
      await page.waitForTimeout(1000);
      await handleDisclaimerIfPresent(page, 'grid-link');
      reachedDetail = await isDetailPage(page);
    }

    console.log(`[andersontax] reachedDetail=${reachedDetail} url=${page.url()}`);

    // ── 5. Extract all data ───────────────────────────────────────────────────
    onProgress('Extracting property data...');
    const detail = await extractDetailData(page, propId);

    // ── 5b. Click "Payment History" tab to load bill tables ──────────────────
    // The tax office detail page has tabs (Details / Bills / Payment History).
    // Bill tables only render after that tab is activated.
    onProgress('Loading payment history...');
    const HISTORY_TAB_SELECTORS = [
      'a:has-text("Payment History")',
      'a:has-text("Bills")',
      'li:has-text("Payment History") a',
      'li:has-text("Bills") a',
      '[href*="PaymentHistory"]',
      '[href*="payment-history"]',
      '[href*="Bills"]',
    ];
    let clickedHistoryTab = false;
    for (const sel of HISTORY_TAB_SELECTORS) {
      try {
        const el = page.locator(sel).first();
        if (await el.count({ timeout: 2000 }) > 0 && await el.isVisible({ timeout: 2000 })) {
          await el.click({ timeout: 5000 });
          await page.waitForTimeout(2500);
          await handleDisclaimerIfPresent(page, 'payment-history-tab');
          console.log(`[andersontax] clicked history tab via: ${sel}`);
          clickedHistoryTab = true;
          break;
        }
      } catch (_) {}
    }

    // If no tab found, scroll to bottom to trigger any lazy-loaded sections
    if (!clickedHistoryTab) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(1500);
    }

    // Wait for at least one bill table to appear (up to 8 s)
    await page.waitForSelector('table', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const bill = await extractBillData(page);

    const ownerName    = detail.ownerName    || basic.ownerName    || '';
    const situsAddress = detail.situsAddress || basic.situsAddress || '';
    const assessed     = detail.assessedValue || basic.assessedValue || '';
    const acctNum      = detail.accountNumber || basic.accountNumber || '';

    console.log(`[andersontax] extracted: owner="${ownerName}" assessed="${assessed}" tables=${bill.billTables.length} currentDue="${bill.currentDue}" pastDue="${bill.pastDue}" totalDue="${bill.totalDue}"`);

    const totalDue   = bill.totalDue   || '';
    const currentDue = bill.currentDue || '';
    const pastDue    = bill.pastDue    || '';

    let paymentStatus = '';
    if (totalDue) {
      paymentStatus = parseFloat(totalDue.replace(/[^0-9.]/g, '')) === 0 ? 'Paid' : 'Balance Due';
    } else if (pastDue && parseFloat(pastDue.replace(/[^0-9.]/g, '')) > 0) {
      paymentStatus = 'Past Due';
    }

    return {
      records: [{
        parcelId:        propId,
        ownerName,
        propertyAddress: situsAddress,
        taxAmountDue:    totalDue || assessed,
        taxYear:         '2025',
        paymentStatus,
        county:          'Anderson',
        state:           'TX',
        additionalDetails: JSON.stringify({
          'Property ID':        propId,
          'Account':            acctNum,
          'Assessed Value':     assessed,
          'Total Taxes Due':    totalDue,
          'Current Due':        currentDue,
          'Past Years Due':     pastDue,
          'Legal Description':  detail.legalDescription  || '',
          'Effective Acres':    detail.acres             || '',
          'Land Value':         detail.landValue         || '',
          'Improvement Value':  detail.improvementValue  || '',
          'Property Status':    detail.propertyStatus    || '',
          'Property Type':      detail.propertyType      || '',
          'Source':             'Anderson County Tax Office',
          'Detail URL':         bill.detailUrl || page.url(),
          'Bill Tables':        bill.billTables  || [],
          'Year Headers':       bill.yearHeaders || [],
        }),
      }],
      totalFound: 1,
      summary: `Found tax record for ${propId}: ${ownerName || 'N/A'}, Total Due: ${totalDue || 'N/A'}, ${bill.billTables.length} year(s) of history.`,
      searchedUrl: bill.detailUrl || page.url(),
    };

  } catch (err) {
    console.log(`[andersontax] error: ${err.message}`);
    return {
      records: [{
        parcelId:        propId,
        ownerName:       '',
        propertyAddress: '',
        taxAmountDue:    '',
        taxYear:         '2025',
        paymentStatus:   '',
        county:          'Anderson',
        state:           'TX',
        additionalDetails: JSON.stringify({
          'Property ID': propId,
          'Source':      'Anderson County Tax Office',
          'Error':       err.message,
        }),
      }],
      totalFound: 1,
      summary: `Tax record lookup for ${propId} encountered an error: ${err.message}`,
      searchedUrl: page.url(),
    };
  }
}

module.exports = { search };
