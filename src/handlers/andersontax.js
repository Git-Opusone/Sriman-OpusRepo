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

    // ── Owner name (clean, from detail page) ─────────────────────────────────
    let ownerName = '';
    const ownerM = text.match(/Owner\s*Name\s*([A-Z][A-Z\s&%']{4,60}?)(?:\s*Owner ID|\s*Exemptions|\s*Percent)/);
    if (ownerM) ownerName = ownerM[1].trim();

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
    let situsAddress = '';
    const addrM = text.match(/(?:Address|Situs)[:\s]+(\d+\s+(?:AN |)[A-Z][A-Z\s]+(?:ROAD|RD|ST|AVE|HWY|BLVD|DR|LN)[^\n\r]{0,40})/i);
    if (addrM) situsAddress = addrM[1].trim();
    if (!situsAddress) {
      const ROAD_RX = /\b(?:ROAD|RD|STREET|ST|AVENUE|AVE|HWY|HIGHWAY|BLVD|DRIVE|DR|LANE|LN|CO(?:UNTY)?\s*RD?)\b/i;
      for (const l of lines) {
        if (/^\d+/.test(l) && ROAD_RX.test(l) && l.length < 80 && !/PALESTINE|TX|75/i.test(l)) { situsAddress = l; break; }
      }
    }

    // ── Assessed value ────────────────────────────────────────────────────────
    let assessedValue = '';
    // Specifically: "2025 CERTIFIED $8,478" or "Assessed Value ... $8,478"
    const avM = text.match(/CERTIFIED\s*\$?\s*([\d,]+)/i)
             || text.match(/Assessed\s*Value\s*[^$\n]{0,20}\$\s*([\d,]+)/i);
    if (avM) assessedValue = `$${avM[1]}`;

    // ── Account number ────────────────────────────────────────────────────────
    let accountNumber = '';
    const acctM = text.match(/Account\s*[\n\r\s:]*(\d{4}-\d{4}-\d{4}-\d{4})/i)
               || text.match(/(\d{4}-\d{4}-\d{4}-\d{4})/);
    if (acctM) accountNumber = acctM[1];

    // ── Legal description ─────────────────────────────────────────────────────
    let legalDescription = '';
    const legalM = text.match(/Legal\s*Description\s*([A-Z0-9][^\n\r]{5,100})/i);
    if (legalM) legalDescription = legalM[1].trim();

    // ── Property info ─────────────────────────────────────────────────────────
    let propertyStatus = '';
    const statusM = text.match(/Property\s*Status\s*(Active|Inactive|[A-Za-z]+)/i);
    if (statusM) propertyStatus = statusM[1].trim();

    let propertyType = '';
    const typeM = text.match(/Property\s*Type\s*(Real|Personal|[A-Za-z]+)/i);
    if (typeM) propertyType = typeM[1].trim();

    return { ownerName, situsAddress, assessedValue, accountNumber, legalDescription, propertyStatus, propertyType };
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
    const bill   = await extractBillData(page);

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
          'Property ID':       propId,
          'Account':           acctNum,
          'Assessed Value':    assessed,
          'Total Taxes Due':   totalDue,
          'Current Due':       currentDue,
          'Past Years Due':    pastDue,
          'Legal Description': detail.legalDescription || '',
          'Property Status':   detail.propertyStatus   || '',
          'Property Type':     detail.propertyType     || '',
          'Source':            'Anderson County Tax Office',
          'Detail URL':        bill.detailUrl || page.url(),
          'Bill Tables':       bill.billTables  || [],
          'Year Headers':      bill.yearHeaders || [],
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
