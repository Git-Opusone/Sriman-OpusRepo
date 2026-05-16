'use strict';

const { detectCaptcha } = require('../../shared/captchaDetector');

// URL patterns:
//   https://camerontax.go2gov.net/cameron/cart/search/showNameSearch.do
//   https://webb.go2gov.net/webb/cart/search/showNameSearch.do
// The county path segment (e.g. "cameron", "webb") is the part after the host.

function countyFromUrl(url) {
  try {
    const u = new URL(url);
    // e.g. /cameron/cart/...  or hostname camerontax → extract "cameron"
    const pathSeg = u.pathname.split('/').filter(Boolean)[0];
    if (pathSeg && pathSeg !== 'cart') {
      return pathSeg.charAt(0).toUpperCase() + pathSeg.slice(1);
    }
    // Fall back to hostname: camerontax.go2gov.net → "Cameron"
    const hostSeg = u.hostname.split('.')[0].replace(/tax$/, '');
    return hostSeg.charAt(0).toUpperCase() + hostSeg.slice(1);
  } catch (_) { return 'TX'; }
}

function searchBaseFromUrl(url) {
  // Returns e.g. https://camerontax.go2gov.net/cameron/cart/search
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean); // ['cameron','cart','search','showNameSearch.do']
    // Keep up to 'search'
    const searchIdx = parts.indexOf('search');
    const basePath = searchIdx >= 0 ? '/' + parts.slice(0, searchIdx + 1).join('/') : u.pathname;
    return `${u.protocol}//${u.host}${basePath}`;
  } catch (_) { return url; }
}

async function safeGoto(page, url, timeout = 30000) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout });
  } catch (_) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 15000) });
      await page.waitForTimeout(2000);
    } catch (_2) {}
  }
}

// ─── Submit the Go2Gov search form ───────────────────────────────────────────

async function submitSearch(page, searchUrl, searchValue) {
  console.log(`[go2gov] navigating to ${searchUrl}`);
  await safeGoto(page, searchUrl, 25000);
  await page.waitForTimeout(1500);

  // Go2Gov has a single unified search input — try common selectors
  const INPUT_SELECTORS = [
    'input[name="criteria"]',
    'input[placeholder*="Search"]',
    'input[placeholder*="Name"]',
    'input[placeholder*="Account"]',
    'input[type="text"]',
    '#criteria',
    '#searchCriteria',
  ];

  let filled = false;
  for (const sel of INPUT_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.count({ timeout: 3000 }) > 0 && await el.isVisible({ timeout: 3000 })) {
        await el.fill(searchValue, { timeout: 8000 });
        console.log(`[go2gov] filled input via: ${sel}`);
        filled = true;
        break;
      }
    } catch (_) {}
  }

  if (!filled) {
    console.log('[go2gov] could not find search input');
    return false;
  }

  // Submit
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 25000 }).catch(() => {}),
      page.keyboard.press('Enter'),
    ]);
    await page.waitForTimeout(2000);
  } catch (e) {
    // try submit button
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 25000 }).catch(() => {}),
        page.click('input[type="submit"], button[type="submit"]', { timeout: 4000 }),
      ]);
      await page.waitForTimeout(2000);
    } catch (_) {}
  }

  console.log(`[go2gov] post-submit URL: ${page.url()}`);
  return true;
}

// ─── Extract results from the search results page ─────────────────────────────

async function extractResults(page) {
  return page.evaluate(() => {
    const results = [];
    // Go2Gov results are typically in a table with rows linking to detail pages
    const tables = Array.from(document.querySelectorAll('table'));
    for (const tbl of tables) {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      if (rows.length < 2) continue;

      const headerRow = rows.find(r => {
        const txt = (r.innerText || '').toLowerCase();
        return txt.includes('account') || txt.includes('owner') || txt.includes('name');
      });
      if (!headerRow) continue;

      const headers = Array.from(headerRow.querySelectorAll('th, td')).map(c => (c.innerText || '').trim().toLowerCase());
      const acctIdx  = headers.findIndex(h => h.includes('account'));
      const ownerIdx = headers.findIndex(h => h.includes('owner') || h.includes('name'));
      const addrIdx  = headers.findIndex(h => h.includes('address') || h.includes('site') || h.includes('situs'));

      for (const row of rows) {
        if (row === headerRow) continue;
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 2) continue;

        let detailUrl = '', acctNum = '', ownerName = '', siteAddr = '';

        // Find detail link
        const link = row.querySelector('a[href]');
        if (link) { detailUrl = link.href; }

        const ct = cells.map(c => (c.innerText || '').trim());
        if (acctIdx >= 0) acctNum = ct[acctIdx] || '';
        if (ownerIdx >= 0) ownerName = ct[ownerIdx] || '';
        if (addrIdx >= 0) siteAddr = ct[addrIdx] || '';

        // Fallback: first linked cell = account
        if (!acctNum && link) acctNum = (link.innerText || '').trim();

        if (acctNum || detailUrl) {
          results.push({ acctNum, detailUrl, ownerName, siteAddr });
        }
      }
      if (results.length) break;
    }

    // Also try list-based results (some Go2Gov versions use <ul> or <div> results)
    if (!results.length) {
      const links = Array.from(document.querySelectorAll('a[href*="showDetail"], a[href*="detail"], a[href*="propertyId"]'));
      for (const a of links) {
        const row = a.closest('tr, li, div.result, div.row');
        const text = (row || a).innerText || '';
        results.push({ acctNum: (a.innerText || '').trim(), detailUrl: a.href, ownerName: text.trim(), siteAddr: '' });
      }
    }
    return results;
  }).catch(() => []);
}

// ─── Extract tax detail from property detail page ─────────────────────────────

async function extractDetail(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    const domMap = {};
    Array.from(document.querySelectorAll('td, th, dt, label')).forEach(el => {
      const lbl = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[:\*]+$/, '').trim();
      if (!lbl || lbl.length > 80) return;
      const sib = el.nextElementSibling || (el.tagName === 'DT' && el.nextElementSibling);
      if (sib) {
        const val = (sib.innerText || '').replace(/\s+/g, ' ').trim();
        if (val && val.length < 400) domMap[lbl] = val;
      }
    });

    const get = (...keys) => keys.map(k => domMap[k.toLowerCase()]).find(v => v) || '';

    const ownerName    = get('owner name', 'owner', 'name') || text.match(/Owner(?:'s)?\s*Name[:\s]+([A-Z][^\n\r]{2,60})/i)?.[1]?.trim() || '';
    const siteAddress  = get('site address', 'situs address', 'property address', 'address', 'location');
    const legalDesc    = get('legal description', 'legal', 'description');
    const acctNum      = get('account number', 'account no', 'account', 'acct', 'property id');
    const assessedVal  = get('appraised value', 'assessed value', 'total appraised', 'market value');

    // Tax amounts
    const totalDue   = text.match(/Total\s+(?:Amount\s+)?Due[:\s]*\$?([\d,]+\.?\d*)/i)?.[1] ? `$${text.match(/Total\s+(?:Amount\s+)?Due[:\s]*\$?([\d,]+\.?\d*)/i)[1]}` : '';
    const currentDue = text.match(/Current\s+(?:Year\s+)?Due[:\s]*\$?([\d,]+\.?\d*)/i)?.[1] ? `$${text.match(/Current\s+(?:Year\s+)?Due[:\s]*\$?([\d,]+\.?\d*)/i)[1]}` : '';

    // Tax tables
    const billTables = [];
    const yearHeaders = [];
    for (const tbl of Array.from(document.querySelectorAll('table'))) {
      const flat = Array.from(tbl.querySelectorAll('tr'))
        .map(r => Array.from(r.querySelectorAll('td, th')).map(c => (c.innerText || '').replace(/\s+/g, ' ').trim()))
        .filter(r => r.some(c => c.length > 0));
      if (flat.length < 2) continue;
      const hasMoney = flat.some(r => r.some(c => /\$[\d,]+/.test(c) || /[\d,]+\.\d{2}/.test(c)));
      const hasTax   = flat.some(r => r.some(c => /tax|levy|due|paid|balance|entity/i.test(c)));
      if (!hasMoney && !hasTax) continue;
      billTables.push(flat);
      const yrM = (tbl.innerText || '').match(/\b((?:19|20)\d{2})\b/);
      yearHeaders.push(yrM ? yrM[1] : '');
    }

    console.log(`[go2gov-extract] owner="${ownerName}" acct="${acctNum}" totalDue="${totalDue}" tables=${billTables.length}`);
    return { ownerName, siteAddress, legalDesc, acctNum, assessedVal, totalDue, currentDue, billTables, yearHeaders, detailUrl: window.location.href };
  }).catch(() => ({
    ownerName: '', siteAddress: '', legalDesc: '', acctNum: '', assessedVal: '',
    totalDue: '', currentDue: '', billTables: [], yearHeaders: [], detailUrl: page.url(),
  }));
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function search(page, { accountNumber = '', firstName = '', lastName = '', fullName = '', onProgress = () => {} }) {
  const currentUrl = page.url();
  const county     = countyFromUrl(currentUrl);
  const searchBase = searchBaseFromUrl(currentUrl);

  const hasAcct = !!(accountNumber || '').trim();
  const hasName = !!(lastName || fullName || '').trim();
  if (!hasAcct && !hasName) return null;

  const searchValue = hasAcct
    ? (accountNumber || '').trim()
    : (lastName || fullName || '').trim().toUpperCase();

  onProgress(`Go2Gov: searching ${county} County...`);
  console.log(`[go2gov] county=${county} searchBase=${searchBase} value="${searchValue}"`);

  try {
    const cap = await detectCaptcha(page);
    if (cap.detected) return { ...cap, searchedUrl: page.url() };

    // Navigate to and submit the name search form
    const searchUrl = `${searchBase}/showNameSearch.do`;
    const submitted = await submitSearch(page, searchUrl, searchValue);
    if (!submitted) return null;

    // Check for no results
    const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (/no\s+(?:records?|results?)\s+found|0\s+record/i.test(bodyText)) {
      return { records: [], totalFound: 0, summary: `No records found for "${searchValue}" in ${county} County.`, searchedUrl: page.url() };
    }

    const cap2 = await detectCaptcha(page);
    if (cap2.detected) return { ...cap2, searchedUrl: page.url() };

    onProgress('Reading search results...');
    const resultsList = await extractResults(page);
    console.log(`[go2gov] found ${resultsList.length} results`);

    if (!resultsList.length) return null;

    const records = [];
    const MAX = 5;
    for (const item of resultsList.slice(0, MAX)) {
      if (!item.detailUrl) continue;
      onProgress(`Loading detail for ${item.acctNum || 'account'}...`);

      try {
        await safeGoto(page, item.detailUrl, 20000);
        await page.waitForTimeout(1500);

        const detail = await extractDetail(page);
        const ownerName   = detail.ownerName   || item.ownerName   || '';
        const siteAddress = detail.siteAddress  || item.siteAddr   || '';
        const acctNum     = detail.acctNum      || item.acctNum    || '';
        const totalDue    = detail.totalDue     || '';
        const assessed    = detail.assessedVal  || '';

        let paymentStatus = '';
        if (totalDue) {
          paymentStatus = parseFloat(totalDue.replace(/[^0-9.]/g, '')) === 0 ? 'Paid' : 'Balance Due';
        }

        records.push({
          parcelId:        acctNum || item.acctNum,
          ownerName,
          propertyAddress: siteAddress,
          taxAmountDue:    totalDue || assessed,
          taxYear:         '2025',
          paymentStatus,
          county,
          state:           'TX',
          additionalDetails: JSON.stringify({
            'Account Number':    acctNum,
            'Assessed Value':    assessed,
            'Total Taxes Due':   totalDue,
            'Current Year Due':  detail.currentDue || '',
            'Legal Description': detail.legalDesc || '',
            'Source':            `${county} County Tax Office (Go2Gov)`,
            'Detail URL':        detail.detailUrl || item.detailUrl,
            'Bill Tables':       detail.billTables  || [],
            'Year Headers':      detail.yearHeaders || [],
          }),
        });
      } catch (e) {
        console.log(`[go2gov] detail error: ${e.message}`);
      }
    }

    if (!records.length) return null;

    return {
      records,
      totalFound: resultsList.length,
      summary: `Found ${resultsList.length} record(s) in ${county} County Tax Office (showing ${records.length}).`,
      searchedUrl: page.url(),
    };
  } catch (err) {
    console.log(`[go2gov] error: ${err.message}`);
    return null;
  }
}

module.exports = { search };
