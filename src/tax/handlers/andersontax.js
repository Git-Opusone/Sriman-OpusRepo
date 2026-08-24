'use strict';

const { detectCaptcha } = require('../../shared/captchaDetector');

function normalizePropId(id) {
  const s = (id || '').trim();
  const withR = /^r/i.test(s) ? s.toUpperCase() : `R${s}`;
  // The CAD side (publicportal.js) cross-references this property via
  // taxOfficeRef/refId, which it zero-pads to a fixed width (e.g. "R0068855"
  // for a property whose real Tax Office ID is "R68855"). Passed through
  // verbatim, the padded ID matches nothing on tax.co.anderson.tx.us and the
  // search silently returns zero results. Strip padding zeros between "R"
  // and the first non-zero digit — the Tax Office site itself never pads.
  return withR.replace(/^R0+(?=\d)/, 'R');
}

function countyFromUrl(url) {
  const m = url.match(/tax\.co\.([a-z]+)\.tx\.us/i);
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : 'TX';
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

// Returns null when accessible, or an error string describing why not.
// Catches Cloudflare 1020 / access-denied / empty pages that fool captchaDetector.
async function checkSiteBlocked(page) {
  try {
    return await page.evaluate(() => {
      const html  = (document.documentElement.innerHTML || '').toLowerCase();
      const text  = (document.body?.innerText || '').toLowerCase();
      const title = (document.title || '').toLowerCase();
      if (html.includes('error 1020') || html.includes('error 1015') || html.includes('error 1006'))
        return 'Cloudflare block (Error 1020/1015/1006) — server IP is not allowed by this county website';
      if ((title.includes('access denied') || text.includes('access denied')) && html.includes('cloudflare'))
        return 'Cloudflare access denied — server IP blocked';
      if (html.includes('cf-error-code') || html.includes('cf-error-details'))
        return 'Cloudflare error page detected';
      if (text.includes('your ip address') && (html.includes('cloudflare') || html.includes('ray id')))
        return 'Cloudflare IP block — server datacenter IP in blocklist';
      // Generic "this site can't be reached" / empty page
      const bodyLen = (document.body?.innerText || '').trim().length;
      if (bodyLen < 30 && !document.querySelector('.k-grid, form, input'))
        return 'Page loaded but appears empty — site may be unreachable from server';
      return null;  // accessible
    });
  } catch (_) { return null; }
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

    // Entity names in the 2025 Kendo grid sometimes include UI navigation text
    // (payment portal links, owner info labels, etc.) alongside real entities.
    // This regex matches strings that are clearly NOT tax entity names.
    const GARBAGE_ENTITY_RX = /pending\s+in\s+the\s+amount|payment\s+processing|click\s+below|custom\s+values|eStatement|secure\s+website|continuing\s+to\s+a|^owner\s+(name|id)$|^(market|land|agricultural)\s+value|entities\s+&\s+exemptions|^tax\s+year$|^exemptions$|^appraised\s+value|sign.?up/i;
    const isGarbageEntityName = (name) =>
      !name || name.length > 70 || GARBAGE_ENTITY_RX.test(name.trim());

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

      // Reject rows that are really a whole accordion panel's text dumped
      // into one oversized cell (page nav, photo/sketch placeholders, etc.)
      // rather than a real bill-history row — such rows still pass the two
      // checks above because that huge blob happens to contain "TAXING
      // ENTITY" and a dollar amount somewhere inside it. A real header or
      // data row never has more than a handful of cells. Filter row-by-row
      // (not the whole table) so one malformed row doesn't discard
      // otherwise-good rows sitting in the same table.
      const sane = flat.filter(r => r.length <= 10);
      if (sane.length < 2) continue; // nothing usable left in this table

      // Filter out Kendo Grid expansion sub-rows (Levy, P&I, Att.Fee, Credits/Disc.)
      // Also filter rows where the first cell (entity name) is clearly UI navigation text.
      const SUB_ROW_RX = /^(Levy|P&I|Att\.?\s*Fee|Credits\s*\/?\s*Disc|Discount)\b/i;
      const cleanFlat = [
        sane[0], // keep header row
        ...sane.slice(1).filter(r => {
          const first = (r[0] || '').trim();
          if (SUB_ROW_RX.test(first)) return false;
          // skip concatenated single-cell summary row "Levy$40.76P&I$0.00..."
          if (r.filter(c => c.length > 0).length <= 2 && /Levy|P&I/i.test(r.join(''))) return false;
          // skip rows where entity name is garbage UI/navigation text
          if (isGarbageEntityName(first)) return false;
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

  const taxBase  = new URL(page.url()).origin;
  const propId   = normalizePropId(accountNumber);
  const stripped = propId.replace(/^r/i, '').toUpperCase();
  onProgress(`TX County Tax Office: searching ${propId}...`);
  console.log(`[andersontax] propId=${propId}`);

  try {
    const cap = await detectCaptcha(page);
    if (cap.detected) return { ...cap, searchedUrl: page.url() };

    // ── 1. Navigate directly to search URL (no home-page pre-visit) ───────────
    const searchUrl = `${taxBase}/Property-Search-Result/searchtext/${encodeURIComponent(propId)}`;
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

    // Check for CAPTCHA or IP-based block on the search results page.
    // EC2 datacenter IPs are often blocked by Cloudflare (Error 1020/1015) —
    // captchaDetector misses these; checkSiteBlocked catches them specifically.
    const capSearch = await detectCaptcha(page);
    if (capSearch.detected) {
      console.log(`[andersontax] CAPTCHA detected on search page: ${capSearch.captchaType}`);
      return { ...capSearch, searchedUrl: page.url() };
    }
    const blockReason = await checkSiteBlocked(page);
    if (blockReason) {
      console.log(`[andersontax] site blocked: ${blockReason} — url=${page.url()}`);
      return {
        records: [{ parcelId: propId, ownerName: '', propertyAddress: '', taxAmountDue: '',
          taxYear: '2025', paymentStatus: '', county: countyFromUrl(taxBase), state: 'TX',
          additionalDetails: JSON.stringify({
            'Property ID': propId,
            'Source': `${countyFromUrl(taxBase)} County Tax Office`,
            'Note': `Anderson County Tax Office website is not accessible from the server: ${blockReason}. Please visit http://tax.co.anderson.tx.us directly to verify tax status.`,
          }) }],
        totalFound: 0,
        summary: `Anderson County Tax Office blocked server access (${blockReason}). Direct access at tax.co.anderson.tx.us required.`,
        searchedUrl: page.url(),
      };
    }

    // ── 2. Wait for Kendo grid and pull search-row data ───────────────────────
    await page.waitForSelector('.k-grid tbody tr, [data-role="grid"] tbody tr',
      { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(1000);

    let basic = await extractFromSearchGrid(page, propId);
    console.log(`[andersontax] grid (R-prefix): owner="${basic.ownerName}" acct="${basic.accountNumber}" link="${basic.propertyLink}"`);

    // If no results with R-prefix AND the grid exists (site IS loaded), retry with plain ID.
    // Skip the retry when grid is absent — it means the page is blocked/unreachable.
    const gridPresent = await page.locator('.k-grid, [data-role="grid"]').count().catch(() => 0) > 0;
    if (!basic.ownerName && !basic.propertyLink && gridPresent) {
      const searchUrlStripped = `${taxBase}/Property-Search-Result/searchtext/${encodeURIComponent(stripped)}`;
      console.log(`[andersontax] R-prefix search empty (grid exists) — retrying with stripped ID`);
      await safeGoto(page, searchUrlStripped, 15000);
      await page.waitForTimeout(1500);
      await handleDisclaimerIfPresent(page, 'search-stripped');
      await page.waitForSelector('.k-grid tbody tr, [data-role="grid"] tbody tr',
        { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1000);
      basic = await extractFromSearchGrid(page, stripped);
      console.log(`[andersontax] grid (stripped): owner="${basic.ownerName}" acct="${basic.accountNumber}" link="${basic.propertyLink}"`);
    }

    // ── 3. Navigate to property detail ────────────────────────────────────────
    // Strategy A: try direct URL patterns with SHORT timeouts (10s each)
    const directUrlCandidates = [
      `${taxBase}/Property-Detail/${encodeURIComponent(propId)}`,
      `${taxBase}/Property-Detail/${encodeURIComponent(stripped)}`,
      `${taxBase}/Property/View/${encodeURIComponent(propId)}`,
    ];

    let reachedDetail = false;
    for (const url of directUrlCandidates) {
      onProgress('Checking property detail...');
      await safeGoto(page, url, 7000);  // short — these are guesses; don't burn timeout budget
      await page.waitForTimeout(800);
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
        const pidCell = page.locator('td').filter({ hasText: new RegExp(`^(${propId}|${stripped})$`) }).first();
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

    // ── 5b. Ensure "Property Details" (bill tables) view is active ──────────────
    // Anderson County uses a "Page:" SELECT DROPDOWN (Kendo DropDownList) to
    // switch between "Property Details" (TAXING ENTITY tables, all years) and
    // "Payment History" (receipts only — no entity breakdown).
    // We MUST land on "Property Details" before running extractBillData.
    onProgress('Loading bill history...');
    let clickedHistoryTab = false;

    // Wait for Kendo to be fully initialized before dropdown strategies.
    // On EC2 (headless, slower CDN), Kendo loads later than on localhost.
    // All 4 strategies silently fail when kendo is undefined — this prevents that.
    await page.waitForFunction(
      () => typeof kendo !== 'undefined' && typeof kendo.widgetInstance === 'function',
      { timeout: 12000 }
    ).catch(() => {
      console.log('[andersontax] Kendo not detected after 12s — proceeding without it');
    });
    await page.waitForTimeout(500);

    const pageUrlBeforeDDL = page.url();
    const pageTitle = await page.title().catch(() => '');
    console.log(`[andersontax] before dropdown switch: url=${pageUrlBeforeDDL} title="${pageTitle}"`);

    // Strategy 0: Kendo JavaScript API — most reliable, bypasses all UI issues
    // Works even when the native <select> is hidden and has no <option> elements.
    clickedHistoryTab = await page.evaluate(() => {
      try {
        const selEls = Array.from(document.querySelectorAll('select, [data-role="dropdownlist"]'));
        for (const el of selEls) {
          let ddl = null;
          if (typeof kendo !== 'undefined') {
            ddl = kendo.widgetInstance ? kendo.widgetInstance(el) : null;
          }
          if (!ddl && typeof jQuery !== 'undefined') {
            ddl = jQuery(el).data('kendoDropDownList');
          }
          if (!ddl || typeof ddl.dataSource === 'undefined') continue;

          const items = Array.from(ddl.dataSource.data ? ddl.dataSource.data() : []);
          console.log('[andersontax] Kendo DDL items: ' + items.map(i => i.text || i.value || String(i)).join(', '));

          const match = items.find(item => {
            const t = String(item.text || item.Text || item.value || item.Value || item);
            return /property\s*details/i.test(t) || /billing/i.test(t);
          });
          if (match) {
            const val = match.value !== undefined ? match.value : (match.text || match.Text || match);
            ddl.value(String(val));
            ddl.trigger('change');
            return true;
          }
          // If items list is empty, try selecting by index 0 or 1 looking for non-history
          const currentText = String(ddl.text ? ddl.text() : '');
          if (/payment\s*history/i.test(currentText) && typeof ddl.select === 'function') {
            const size = items.length || 2;
            for (let idx = 0; idx < size; idx++) {
              ddl.select(idx);
              const newText = String(ddl.text ? ddl.text() : '');
              if (!/payment\s*history/i.test(newText)) {
                ddl.trigger('change');
                return true;
              }
            }
          }
        }
      } catch (_) {}
      return false;
    }).catch(() => false);
    if (clickedHistoryTab) {
      await page.waitForTimeout(2500);
      console.log('[andersontax] Page dropdown → Property Details via Kendo API');
    }

    // Strategy 1: Playwright selectOption with force (handles hidden Kendo-wrapped selects)
    if (!clickedHistoryTab) {
      try {
        const selects = page.locator('select');
        const selCount = await selects.count();
        for (let si = 0; si < selCount && !clickedHistoryTab; si++) {
          const sel = selects.nth(si);
          // Read option text including from hidden selects (don't check isVisible)
          const opts = await sel.locator('option').allInnerTexts().catch(() => []);
          if (opts.length === 0) continue;
          console.log(`[andersontax] select[${si}] options: ${opts.join(', ')}`);
          const detailsOpt = opts.find(o => /property\s+details/i.test(o) || /billing/i.test(o));
          if (detailsOpt) {
            await sel.selectOption({ label: detailsOpt }, { force: true });
            await page.waitForTimeout(2500);
            console.log(`[andersontax] Page dropdown (force) → "${detailsOpt}"`);
            clickedHistoryTab = true;
          }
        }
      } catch (_) {}
    }

    // Strategy 2: Click the visible Kendo DropDownList wrapper, pick "Property Details" from popup
    if (!clickedHistoryTab) {
      try {
        // .k-dropdown is the visible wrapper span Kendo renders around the hidden <select>
        const kdlWrap = page.locator('.k-dropdown, .k-dropdownlist, [data-role="dropdownlist"]').first();
        if (await kdlWrap.isVisible({ timeout: 2000 }).catch(() => false)) {
          await kdlWrap.click({ timeout: 3000 });
          await page.waitForTimeout(600);
          const popup = page.locator('.k-list-container li, .k-popup li, .k-list li, .k-item');
          const detailItem = popup.filter({ hasText: /property\s+details/i }).first();
          if (await detailItem.count() > 0) {
            await detailItem.click({ timeout: 3000 });
            await page.waitForTimeout(2500);
            clickedHistoryTab = true;
            console.log('[andersontax] Page dropdown → Property Details via Kendo popup click');
          } else {
            await page.keyboard.press('Escape').catch(() => {});
          }
        }
      } catch (_) {}
    }

    // Strategy 3: Tab/link selectors (fallback for non-Kendo TX county tax sites)
    if (!clickedHistoryTab) {
      const TAB_SELECTORS = [
        'a:has-text("Property Details")',
        'li:has-text("Property Details") a',
        'a:has-text("Bills")',
        'li:has-text("Bills") a',
        '[href*="Bills"]',
        'a:has-text("Payment History")',
        'li:has-text("Payment History") a',
        '[href*="PaymentHistory"]',
        '[href*="payment-history"]',
      ];
      for (const tabSel of TAB_SELECTORS) {
        try {
          const el = page.locator(tabSel).first();
          if (await el.count() > 0 && await el.isVisible({ timeout: 2000 })) {
            await el.click({ timeout: 5000 });
            await page.waitForTimeout(2500);
            await handleDisclaimerIfPresent(page, 'history-tab');
            console.log(`[andersontax] clicked tab via: ${tabSel}`);
            clickedHistoryTab = true;
            break;
          }
        } catch (_) {}
      }
    }

    // If no navigation matched, scroll to trigger any lazy-loaded sections
    if (!clickedHistoryTab) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(1500);
    }

    // Expand ALL collapsed Kendo accordion sections (current year may be collapsed by default)
    try {
      await page.evaluate(async () => {
        // Click every collapsed aria-expanded panel
        const collapsed = Array.from(document.querySelectorAll('[aria-expanded="false"]'));
        for (const el of collapsed) {
          try { el.click(); await new Promise(r => setTimeout(r, 250)); } catch (_) {}
        }
        // Kendo collapse icons and ">>>" toggle spans
        const toggles = Array.from(document.querySelectorAll(
          '.k-i-arrow-e, .k-i-expand, [class*="expand"], [class*="toggle"]'
        ));
        for (const el of toggles) {
          if (!el.offsetParent) continue; // skip hidden elements
          try { el.click(); await new Promise(r => setTimeout(r, 250)); } catch (_) {}
        }
        // Bare text toggles: ">", ">>>", "▶", "+"
        for (const el of Array.from(document.querySelectorAll('span,button,a,div'))) {
          if (el.children.length > 0) continue;
          const t = (el.textContent || '').trim();
          if (/^(>>>?|▶|\+)$/.test(t) && el.offsetParent) {
            try { el.click(); await new Promise(r => setTimeout(r, 250)); } catch (_) {}
          }
        }
      });
      await page.waitForTimeout(1500);
      console.log('[andersontax] accordion expansion done');
    } catch (_) {}

    // Wait for a TAXING ENTITY table to appear (up to 12 s for lazy/AJAX load)
    await page.waitForFunction(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      return tables.some(t => /TAXING\s*ENTITY/i.test(t.innerText || t.textContent || ''));
    }, { timeout: 12000 }).catch(async () => {
      // Fallback: just wait for any table
      await page.waitForSelector('table', { timeout: 4000 }).catch(() => {});
    });
    await page.waitForTimeout(2000);

    const bill = await extractBillData(page);

    if (bill.billTables.length === 0) {
      const finalUrl   = page.url();
      const finalTitle = await page.title().catch(() => '');
      const bodySnippet = await page.evaluate(
        () => (document.body?.innerText || '').slice(0, 400).replace(/\s+/g, ' ')
      ).catch(() => '');
      console.log(`[andersontax] NO bill tables — finalUrl=${finalUrl} title="${finalTitle}"`);
      console.log(`[andersontax] page snippet: ${bodySnippet}`);
    }

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
        county:          countyFromUrl(taxBase),
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
          'Source':             `${countyFromUrl(taxBase)} County Tax Office`,
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
        county:          countyFromUrl(taxBase),
        state:           'TX',
        additionalDetails: JSON.stringify({
          'Property ID': propId,
          'Source':      `${countyFromUrl(taxBase)} County Tax Office`,
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
