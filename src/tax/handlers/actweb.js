'use strict';

const { detectCaptcha } = require('../../shared/captchaDetector');

function countyFromUrl(url) {
  const m = url.match(/act_webdev\/([^/]+)\//i);
  if (!m) return 'TX';
  const raw = m[1].toLowerCase();
  if (raw === 'fbc') return 'Fort Bend';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function baseFromUrl(url) {
  // Returns e.g. https://actweb.acttax.com/act_webdev/galveston
  // Handles both actweb.acttax.com and {county}.acttax.com subdomain variants
  const m = url.match(/(https?:\/\/[^/]+\.acttax\.com\/act_webdev\/[^/]+)/i);
  return m ? m[1] : new URL(url).origin;
}

async function safeGoto(page, url, timeout = 45000) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout });
  } catch (_) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 20000) });
      await page.waitForTimeout(3000);
    } catch (_2) {}
  }
}

// ─── Submit search form on index.jsp ─────────────────────────────────────────

async function submitSearch(page, actBase, searchValue, searchBy) {
  const indexUrl = `${actBase}/index.jsp`;
  console.log(`[actweb] navigating to ${indexUrl}`);
  await safeGoto(page, indexUrl);

  // Fill search criteria
  try {
    await page.waitForSelector('input[name="criteria"]', { timeout: 10000 });
    await page.fill('input[name="criteria"]', searchValue);
  } catch (e) {
    console.log(`[actweb] criteria input not found: ${e.message}`);
    return false;
  }

  // Select search type radio button
  try {
    await page.check(`input[name="searchby"][value="${searchBy}"]`, { timeout: 5000 }).catch(() => {});
  } catch (_) {}

  // Submit form
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 45000 }).catch(() => {}),
      page.click('input[type="submit"], button[type="submit"]', { timeout: 5000 }),
    ]);
    await page.waitForTimeout(2000);
  } catch (e) {
    console.log(`[actweb] submit error: ${e.message}`);
    return false;
  }

  console.log(`[actweb] post-submit URL: ${page.url()}`);
  return true;
}

// ─── Extract account list from showlist.jsp results table ─────────────────────

async function extractResultsList(page) {
  return page.evaluate(() => {
    const results = [];
    const tables = Array.from(document.querySelectorAll('table'));
    for (const tbl of tables) {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      if (rows.length < 2) continue;

      // Find header row to detect column positions
      const headerRow = rows.find(r => {
        const txt = (r.innerText || '').toLowerCase();
        return txt.includes('account') || txt.includes('owner');
      });
      if (!headerRow) continue;

      const headerCells = Array.from(headerRow.querySelectorAll('th, td')).map(c => (c.innerText || '').trim().toLowerCase());
      const acctCol  = headerCells.findIndex(h => h.includes('account') && !h.includes('long'));
      const ownerCol = headerCells.findIndex(h => h.includes('owner'));
      const addrCol  = headerCells.findIndex(h => h.includes('site') || h.includes('address'));

      // Walk data rows
      for (const row of rows) {
        if (row === headerRow) continue;
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 2) continue;

        // Look for account number link
        let acctNum = '', detailUrl = '', ownerName = '', siteAddress = '';
        const links = row.querySelectorAll('a[href]');
        for (const a of Array.from(links)) {
          const href = a.href || '';
          if (href.includes('showdetail') || href.includes('detail') || /acct|prop|account/i.test(href)) {
            detailUrl = href;
            acctNum = (a.innerText || '').trim();
            break;
          }
        }

        // If no explicit detail link, use first cell link
        if (!detailUrl && cells[0]) {
          const a = cells[0].querySelector('a');
          if (a) { detailUrl = a.href; acctNum = acctNum || (a.innerText || '').trim(); }
        }

        // Extract text by column index
        const ct = cells.map(c => (c.innerText || '').trim());
        if (acctCol >= 0 && ct[acctCol]) acctNum = acctNum || ct[acctCol];
        if (ownerCol >= 0) ownerName = ct[ownerCol] || '';
        if (addrCol >= 0)  siteAddress = ct[addrCol] || '';
        if (!ownerName && ct.length > 1) ownerName = ct[1] || '';

        if (acctNum || detailUrl) {
          results.push({ acctNum, detailUrl, ownerName, siteAddress });
        }
      }

      if (results.length > 0) break;
    }
    return results;
  }).catch(() => []);
}

// ─── Extract tax data from detail page ────────────────────────────────────────

async function extractDetailPage(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    // ── Basic fields from label:value DOM scan ────────────────────────────────
    const domMap = {};
    Array.from(document.querySelectorAll('td, th')).forEach(el => {
      const lbl = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[:\*]+$/, '').trim();
      if (!lbl || lbl.length > 80) return;
      const sib = el.nextElementSibling;
      if (sib) {
        const val = (sib.innerText || '').replace(/\s+/g, ' ').trim();
        if (val && val.length < 400) domMap[lbl] = val;
      }
    });

    const get = (...keys) => {
      for (const k of keys) {
        const v = domMap[k.toLowerCase()];
        if (v) return v;
      }
      return '';
    };

    let ownerName    = get('owner name', 'owner', 'name');
    let siteAddress  = get('site address', 'situs address', 'property address', 'address');
    let legalDesc    = get('legal description', 'legal desc', 'description');
    let accountNum   = get('account number', 'account no', 'account', 'acct');
    let assessedVal  = get('appraised value', 'assessed value', 'total appraised value');

    // Text fallbacks
    if (!ownerName) {
      const m = text.match(/Owner(?:'s)?\s*Name[:\s]+([A-Z][^\n\r]{2,80})/i);
      if (m) ownerName = m[1].trim();
    }
    if (!accountNum) {
      const m = text.match(/Account\s*(?:No|Number|#)[:\s]+([A-Z0-9\-]+)/i);
      if (m) accountNum = m[1].trim();
    }
    if (!assessedVal) {
      const m = text.match(/(?:Appraised|Assessed)\s*Value[:\s]*\$?([\d,]+)/i);
      if (m) assessedVal = `$${m[1]}`;
    }

    // ── Current amount due ────────────────────────────────────────────────────
    let totalDue = '', currentDue = '';
    const totalM   = text.match(/Total\s+(?:Amount\s+)?Due[:\s]*\$?([\d,]+\.?\d*)/i);
    const currentM = text.match(/Current\s+(?:Amount\s+)?Due[:\s]*\$?([\d,]+\.?\d*)/i);
    if (totalM)   totalDue   = `$${totalM[1]}`;
    if (currentM) currentDue = `$${currentM[1]}`;

    // ── Tax tables — find tables with year/entity breakdown ───────────────────
    const billTables = [];
    const yearHeaders = [];

    for (const tbl of Array.from(document.querySelectorAll('table'))) {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      const flat = rows
        .map(r => Array.from(r.querySelectorAll('td, th')).map(c => (c.innerText || '').replace(/\s+/g, ' ').trim()))
        .filter(r => r.some(c => c.length > 0));

      if (flat.length < 2) continue;

      // Must have dollar amounts or tax-related content
      const hasDollar = flat.some(r => r.some(c => /\$[\d,]+/.test(c) || /[\d,]+\.\d{2}/.test(c)));
      const hasTaxContent = flat.some(r => r.some(c => /taxing|entity|levy|due|paid|balance/i.test(c)));

      if (!hasDollar && !hasTaxContent) continue;
      if (flat[0] && flat[0].join('').length < 3) continue;

      billTables.push(flat);

      // Extract year from nearby text or table content
      let yearLabel = '';
      const tblText = tbl.innerText || '';
      const yrM = tblText.match(/\b((?:19|20)\d{2})\b/);
      if (yrM) yearLabel = yrM[1];

      // Walk up DOM for year heading
      if (!yearLabel) {
        let el = tbl;
        for (let d = 0; d < 6 && !yearLabel; d++) {
          let sib = el.previousElementSibling;
          while (sib && !yearLabel) {
            const t = (sib.innerText || '').trim();
            const m = t.match(/\b((?:19|20)\d{2})\b/);
            if (m) yearLabel = m[1];
            sib = sib.previousElementSibling;
          }
          el = el.parentElement;
          if (!el) break;
        }
      }
      yearHeaders.push(yearLabel);
    }

    console.log(`[actweb-extract] owner="${ownerName}" acct="${accountNum}" assessed="${assessedVal}" totalDue="${totalDue}" tables=${billTables.length}`);

    return { ownerName, siteAddress, legalDesc, accountNum, assessedVal, totalDue, currentDue, billTables, yearHeaders, detailUrl: window.location.href };
  }).catch(() => ({
    ownerName: '', siteAddress: '', legalDesc: '', accountNum: '', assessedVal: '',
    totalDue: '', currentDue: '', billTables: [], yearHeaders: [], detailUrl: page.url(),
  }));
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function search(page, { accountNumber = '', firstName = '', lastName = '', fullName = '', onProgress = () => {} }) {
  const actBase  = baseFromUrl(page.url());
  const county   = countyFromUrl(page.url());
  const hasAcct  = !!(accountNumber || '').trim();
  const hasName  = !!(lastName || fullName || '').trim();

  if (!hasAcct && !hasName) return null;

  const searchValue = hasAcct
    ? (accountNumber || '').trim()
    : (lastName || fullName || '').trim().toUpperCase();
  const searchBy = hasAcct ? '4' : '3';

  onProgress(`ACTweb: searching ${county} County...`);
  console.log(`[actweb] county=${county} base=${actBase} searchBy=${searchBy} value="${searchValue}"`);

  try {
    const cap = await detectCaptcha(page);
    if (cap.detected) return { ...cap, searchedUrl: page.url() };

    // Submit search form
    let submitted = await submitSearch(page, actBase, searchValue, searchBy);
    if (!submitted) {
      console.log('[actweb] form submit failed');
      return null;
    }

    // Check for no results — if account search found nothing, try owner name fallback
    let pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (/no\s+records?\s+found|no\s+results|0\s+record/i.test(pageText) && hasAcct) {
      const nameFallback = (lastName || fullName || firstName || '').trim().toUpperCase();
      if (nameFallback) {
        console.log(`[actweb] account search empty — retrying with name: "${nameFallback}"`);
        onProgress(`ACTweb: retrying with owner name "${nameFallback}"...`);
        submitted = await submitSearch(page, actBase, nameFallback, '3');
        if (submitted) {
          pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
        }
      }
    }
    if (/no\s+records?\s+found|no\s+results|0\s+record/i.test(pageText)) {
      return { records: [], totalFound: 0, summary: `No records found for "${searchValue}" in ${county} County.`, searchedUrl: page.url() };
    }

    // Check captcha on results page
    const cap2 = await detectCaptcha(page);
    if (cap2.detected) return { ...cap2, searchedUrl: page.url() };

    // ── Extract results list ──────────────────────────────────────────────────
    onProgress('Reading search results...');
    const resultsList = await extractResultsList(page);
    console.log(`[actweb] found ${resultsList.length} results`);

    if (!resultsList.length) return null;

    const records = [];
    const MAX_DETAIL = 5;
    const toProcess = resultsList.slice(0, MAX_DETAIL);

    for (const item of toProcess) {
      if (!item.detailUrl) continue;

      onProgress(`Loading detail for ${item.acctNum || 'account'}...`);
      console.log(`[actweb] detail URL: ${item.detailUrl}`);

      try {
        await safeGoto(page, item.detailUrl);
        await page.waitForTimeout(1500);

        const detail = await extractDetailPage(page);
        const ownerName    = detail.ownerName    || item.ownerName    || '';
        const siteAddress  = detail.siteAddress  || item.siteAddress  || '';
        const acctNum      = detail.accountNum   || item.acctNum      || '';
        const totalDue     = detail.totalDue     || '';
        const currentDue   = detail.currentDue   || '';
        const assessed     = detail.assessedVal  || '';

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
            'Current Due':       currentDue,
            'Legal Description': detail.legalDesc || '',
            'Source':            `${county} County Tax Office (ACTweb)`,
            'Detail URL':        detail.detailUrl || item.detailUrl,
            'Bill Tables':       detail.billTables  || [],
            'Year Headers':      detail.yearHeaders || [],
          }),
        });
      } catch (detailErr) {
        console.log(`[actweb] detail error for ${item.acctNum}: ${detailErr.message}`);
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
    console.log(`[actweb] error: ${err.message}`);
    return null;
  }
}

module.exports = { search };
