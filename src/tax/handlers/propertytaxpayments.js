'use strict';

const { detectCaptcha } = require('../../shared/captchaDetector');

// URL: https://{county}.propertytaxpayments.net/search
// Platform: PropertyTaxPayments.net (FIS/ACI) — ~191 TX counties
// Cloudflare Turnstile is common — stealth mode helps but may not always bypass it

function countyFromUrl(url) {
  try {
    const host = new URL(url).hostname;          // e.g. "bell.propertytaxpayments.net"
    const seg  = host.split('.')[0];              // e.g. "bell"
    return seg.charAt(0).toUpperCase() + seg.slice(1);
  } catch (_) { return 'TX'; }
}

function baseFromUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch (_) { return url; }
}

async function safeGoto(page, url, timeout = 35000) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3000);             // let Cloudflare JS execute
  } catch (_) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: Math.min(timeout, 20000) });
      await page.waitForTimeout(3000);
    } catch (_2) {}
  }
}

// ─── Search form interaction ──────────────────────────────────────────────────

async function submitSearch(page, searchBase, searchValue) {
  const searchUrl = searchBase.replace(/\/search\/?$/, '') + '/search';
  console.log(`[ptp] navigating to ${searchUrl}`);
  await safeGoto(page, searchUrl, 30000);

  const cap = await detectCaptcha(page);
  if (cap.detected) return { captchaBlocked: true, ...cap };

  // Common input selectors for PropertyTaxPayments.net
  const INPUT_SELECTORS = [
    'input[name="ownerName"]',
    'input[name="owner"]',
    'input[name="criteria"]',
    'input[name="accountNumber"]',
    'input[name="searchText"]',
    'input[placeholder*="Owner" i]',
    'input[placeholder*="Name" i]',
    'input[placeholder*="Account" i]',
    'input[placeholder*="Search" i]',
    'input[type="search"]',
    'input[type="text"]',
  ];

  let filled = false;
  for (const sel of INPUT_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.count({ timeout: 2000 }) > 0 && await el.isVisible({ timeout: 2000 })) {
        await el.fill(searchValue, { timeout: 5000 });
        console.log(`[ptp] filled input: ${sel}`);
        filled = true;
        break;
      }
    } catch (_) {}
  }

  if (!filled) {
    console.log('[ptp] could not find search input');
    return { noInput: true };
  }

  // Submit via Enter or button
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {}),
      page.keyboard.press('Enter'),
    ]);
    await page.waitForTimeout(2000);
  } catch (_) {
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {}),
        page.click('input[type="submit"], button[type="submit"], button:has-text("Search")', { timeout: 4000 }),
      ]);
      await page.waitForTimeout(2000);
    } catch (_2) {}
  }

  return { filled: true };
}

// ─── Extract results list ─────────────────────────────────────────────────────

async function extractResults(page) {
  return page.evaluate(() => {
    const results = [];

    // PropertyTaxPayments.net uses a table or card-based results layout
    const tables = Array.from(document.querySelectorAll('table'));
    for (const tbl of tables) {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      if (rows.length < 2) continue;

      const headerRow = rows.find(r => {
        const txt = (r.innerText || '').toLowerCase();
        return txt.includes('account') || txt.includes('owner') || txt.includes('name');
      });
      if (!headerRow) continue;

      const headers = Array.from(headerRow.querySelectorAll('th, td'))
        .map(c => (c.innerText || '').trim().toLowerCase());
      const acctIdx  = headers.findIndex(h => h.includes('account'));
      const ownerIdx = headers.findIndex(h => h.includes('owner') || h.includes('name'));
      const addrIdx  = headers.findIndex(h => h.includes('address') || h.includes('situs'));

      for (const row of rows) {
        if (row === headerRow) continue;
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 2) continue;

        const link = row.querySelector('a[href]');
        const ct   = cells.map(c => (c.innerText || '').trim());

        const acctNum   = acctIdx  >= 0 ? ct[acctIdx]  || '' : (link ? (link.innerText || '').trim() : '');
        const ownerName = ownerIdx >= 0 ? ct[ownerIdx] || '' : '';
        const siteAddr  = addrIdx  >= 0 ? ct[addrIdx]  || '' : '';
        const detailUrl = link ? link.href : '';

        if (acctNum || detailUrl) {
          results.push({ acctNum, detailUrl, ownerName, siteAddr });
        }
      }
      if (results.length) break;
    }

    // Fallback: find detail links directly
    if (!results.length) {
      const links = Array.from(document.querySelectorAll('a[href*="detail"], a[href*="property"], a[href*="account"]'));
      for (const a of links) {
        const row  = a.closest('tr, li, div.result, div.row, div.card') || a;
        const text = (row.innerText || '').trim();
        if (text) {
          results.push({ acctNum: (a.innerText || '').trim(), detailUrl: a.href, ownerName: text, siteAddr: '' });
        }
      }
    }

    return results;
  }).catch(() => []);
}

// ─── Extract detail page ──────────────────────────────────────────────────────

async function extractDetail(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';

    const domMap = {};
    Array.from(document.querySelectorAll('td, th, dt, label')).forEach(el => {
      const lbl = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[:\*]+$/, '').trim();
      if (!lbl || lbl.length > 80) return;
      const sib = el.nextElementSibling;
      if (sib) {
        const val = (sib.innerText || '').replace(/\s+/g, ' ').trim();
        if (val && val.length < 400) domMap[lbl] = val;
      }
    });

    const get = (...keys) => keys.map(k => domMap[k.toLowerCase()]).find(v => v) || '';

    const ownerName   = get('owner name', 'owner', 'name');
    const siteAddress = get('site address', 'situs address', 'property address', 'address');
    const legalDesc   = get('legal description', 'legal', 'description');
    const acctNum     = get('account number', 'account no', 'account', 'acct', 'property id');
    const assessedVal = get('appraised value', 'assessed value', 'market value', 'total appraised');

    const totalM   = text.match(/Total\s+(?:Amount\s+)?Due[:\s]*\$?([\d,]+\.?\d*)/i);
    const currentM = text.match(/Current\s+(?:Year\s+)?Due[:\s]*\$?([\d,]+\.?\d*)/i);
    const totalDue   = totalM   ? `$${totalM[1]}`   : '';
    const currentDue = currentM ? `$${currentM[1]}` : '';

    const billTables  = [];
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

    return { ownerName, siteAddress, legalDesc, acctNum, assessedVal, totalDue, currentDue, billTables, yearHeaders, detailUrl: window.location.href };
  }).catch(() => ({
    ownerName: '', siteAddress: '', legalDesc: '', acctNum: '', assessedVal: '',
    totalDue: '', currentDue: '', billTables: [], yearHeaders: [], detailUrl: page.url(),
  }));
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function search(page, { accountNumber = '', firstName = '', lastName = '', fullName = '', onProgress = () => {} }) {
  const county     = countyFromUrl(page.url());
  const searchBase = baseFromUrl(page.url());

  const hasAcct = !!(accountNumber || '').trim();
  const hasName = !!(lastName || fullName || firstName || '').trim();
  if (!hasAcct && !hasName) return null;

  onProgress(`PropertyTaxPayments: searching ${county} County...`);
  console.log(`[ptp] county=${county} base=${searchBase}`);

  try {
    // Detect Cloudflare on the initial page load
    const cap0 = await detectCaptcha(page);
    if (cap0.detected) return { ...cap0, searchedUrl: page.url() };

    // Try account number search first; fall back to owner name if needed
    let searchValue = hasAcct
      ? (accountNumber || '').trim()
      : (lastName || fullName || firstName || '').trim().toUpperCase();

    let submitResult = await submitSearch(page, searchBase + '/search', searchValue);
    if (submitResult.captchaBlocked) return { ...submitResult, searchedUrl: page.url() };
    if (submitResult.noInput) return null;

    // Check for no results; retry with name if account search found nothing
    let bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (/no\s+(?:results?|records?)\s*found|0\s+results?|not\s+found/i.test(bodyText) && hasAcct && hasName) {
      const nameFallback = (lastName || fullName || firstName || '').trim().toUpperCase();
      console.log(`[ptp] account search empty — retrying with name: "${nameFallback}"`);
      onProgress(`PropertyTaxPayments: retrying with name "${nameFallback}"...`);
      submitResult = await submitSearch(page, searchBase + '/search', nameFallback);
      if (submitResult.captchaBlocked) return { ...submitResult, searchedUrl: page.url() };
      bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    }

    const cap2 = await detectCaptcha(page);
    if (cap2.detected) return { ...cap2, searchedUrl: page.url() };

    if (/no\s+(?:results?|records?)\s*found|0\s+results?|not\s+found/i.test(bodyText)) {
      return { records: [], totalFound: 0, summary: `No records found for "${searchValue}" in ${county} County.`, searchedUrl: page.url() };
    }

    onProgress('Reading search results...');
    const resultsList = await extractResults(page);
    console.log(`[ptp] found ${resultsList.length} results`);

    if (!resultsList.length) return null;

    const records = [];
    const MAX = 5;
    for (const item of resultsList.slice(0, MAX)) {
      if (!item.detailUrl) continue;
      onProgress(`Loading detail for ${item.acctNum || 'account'}...`);
      try {
        await page.goto(item.detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);

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
          taxYear:         new Date().getFullYear().toString(),
          paymentStatus,
          county,
          state:           'TX',
          additionalDetails: JSON.stringify({
            'Account Number':    acctNum,
            'Assessed Value':    assessed,
            'Total Taxes Due':   totalDue,
            'Current Year Due':  detail.currentDue || '',
            'Legal Description': detail.legalDesc || '',
            'Source':            `${county} County Tax Office (PropertyTaxPayments.net)`,
            'Detail URL':        detail.detailUrl || item.detailUrl,
            'Bill Tables':       detail.billTables  || [],
            'Year Headers':      detail.yearHeaders || [],
          }),
        });
      } catch (e) {
        console.log(`[ptp] detail error: ${e.message}`);
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
    console.log(`[ptp] error: ${err.message}`);
    return null;
  }
}

module.exports = { search };
