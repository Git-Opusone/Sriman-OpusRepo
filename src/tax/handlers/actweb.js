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

/**
 * Clean an owner name for actweb search:
 * - Remove & (actweb stores names without it: "SMITH DENNIS A NORMA A")
 * - Collapse extra whitespace
 */
function cleanNameForActweb(name) {
  return (name || '')
    .replace(/\s*&\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

// ─── Submit search form on index.jsp ─────────────────────────────────────────

async function submitSearch(page, actBase, searchValue, searchBy) {
  const indexUrl = `${actBase}/index.jsp`;
  console.log(`[actweb] navigating to ${indexUrl}`);
  await safeGoto(page, indexUrl);

  try {
    await page.waitForSelector('input[name="criteria"]', { timeout: 10000 });
    await page.fill('input[name="criteria"]', searchValue);
  } catch (e) {
    console.log(`[actweb] criteria input not found: ${e.message}`);
    return false;
  }

  try {
    await page.check(`input[name="searchby"][value="${searchBy}"]`, { timeout: 5000 }).catch(() => {});
  } catch (_) {}

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

// ─── Extract account list from showlist.jsp ───────────────────────────────────

async function extractResultsList(page) {
  return page.evaluate(() => {
    const results = [];
    const tables = Array.from(document.querySelectorAll('table'));
    for (const tbl of tables) {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      if (rows.length < 2) continue;

      const headerRow = rows.find(r => {
        const txt = (r.innerText || '').toLowerCase();
        return txt.includes('account') || txt.includes('owner');
      });
      if (!headerRow) continue;

      const headerCells = Array.from(headerRow.querySelectorAll('th, td'))
        .map(c => (c.innerText || '').trim().toLowerCase());
      const acctCol  = headerCells.findIndex(h => h.includes('account') && !h.includes('long'));
      const ownerCol = headerCells.findIndex(h => h.includes('owner'));
      const addrCol  = headerCells.findIndex(h => h.includes('site') || h.includes('address'));

      for (const row of rows) {
        if (row === headerRow) continue;
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 2) continue;

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

        if (!detailUrl && cells[0]) {
          const a = cells[0].querySelector('a');
          if (a) { detailUrl = a.href; acctNum = acctNum || (a.innerText || '').trim(); }
        }

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

// ─── Extract tax data from showdetail2.jsp ────────────────────────────────────
//
// actweb uses "<b>Label:</b>&nbsp;Value" inside a single <td> — NOT adjacent
// cells. We rely on text regex rather than DOM sibling traversal.

async function extractDetailPage(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';

    function grab(text, ...patterns) {
      for (const pat of patterns) {
        const m = text.match(pat);
        if (m && m[1]) return m[1].trim();
      }
      return '';
    }

    const accountNum  = grab(text, /Account\s*(?:No\.?|Number|#)[:\s]+([A-Z0-9\-]+)/i);
    const cadRef      = grab(text, /Appraisal\s+District\s+(?:Number|No\.?)[:\s]*([\d]+)/i);
    const ownerName   = grab(text,
      /Owner(?:'s)?\s*Name[:\s]+([A-Z][^\n\r]{2,80})/i,
      /Certified\s+Owner[:\s]+([A-Z][^\n\r]{2,80})/i
    );
    const siteAddress = grab(text,
      /Property\s+Site\s+Address[:\s]+([^\n\r]{4,80})/i,
      /Parcel\s+Address[:\s]+([^\n\r]{4,80})/i
    );
    const legalDesc   = grab(text, /Legal\s+Description[:\s]+([^\n\r]{4,200})/i);

    // Monetary fields — actweb showdetail2.jsp layout
    const taxLevy     = grab(text, /Current\s+Tax\s+Levy[:\s]*\$?([\d,]+\.?\d*)/i);
    const currentDue  = grab(text, /Current\s+(?:Year\s+)?Amount\s+Due[:\s]*\$?([\d,]+\.?\d*)/i);
    const priorDue    = grab(text, /Prior\s+Year\s+Amount\s+Due[:\s]*\$?([\d,]+\.?\d*)/i);
    const totalDue    = grab(text,
      /Total\s+Amount\s+Due[:\s]*\$?([\d,]+\.?\d*)/i,
      /Total\s+Due[:\s]*\$?([\d,]+\.?\d*)/i
    );
    const lastPayAmt  = grab(text, /Last\s+Payment\s+Amount[^:\n]*[:\s]*\$?([\d,]+\.?\d*)/i);
    const lastPayDate = grab(text, /Last\s+Payment\s+Date[^:\n]*[:\s]*([\d\/]+)/i);

    // Assessed / value fields
    const grossVal    = grab(text, /Gross\s*Value[:\s]*\$?([\d,]+)/i);
    const landVal     = grab(text, /Land\s*Value[:\s]*\$?([\d,]+)/i);
    const impVal      = grab(text,
      /Improvement\s*Value[:\s]*\$?([\d,]+)/i,
      /Improvement[:\s]*\$?([\d,]+)/i
    );
    const cappedVal   = grab(text, /Capped\s*Value[:\s]*\$?([\d,]+)/i);
    const agVal       = grab(text, /Agricultural\s*(?:Market\s*)?Value[:\s]*\$?([\d,]+)/i);

    // Format a dollar string
    const fmt = v => v ? `$${v}` : '';

    // ── Tax tables (per-entity breakdown) ──────────────────────────────────────
    const billTables = [];
    const yearHeaders = [];

    for (const tbl of Array.from(document.querySelectorAll('table'))) {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      const flat = rows
        .map(r => Array.from(r.querySelectorAll('td, th'))
          .map(c => (c.innerText || '').replace(/\s+/g, ' ').trim()))
        .filter(r => r.some(c => c.length > 0));

      if (flat.length < 2) continue;
      const hasDollar  = flat.some(r => r.some(c => /\$[\d,]+/.test(c) || /[\d,]+\.\d{2}/.test(c)));
      const hasTaxKw   = flat.some(r => r.some(c => /taxing|entity|levy|due|paid|balance|unit/i.test(c)));
      if (!hasDollar && !hasTaxKw) continue;
      if (flat[0] && flat[0].join('').length < 3) continue;

      billTables.push(flat);
      const yrM = (tbl.innerText || '').match(/\b((?:19|20)\d{2})\b/);
      let yearLabel = yrM ? yrM[1] : '';
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

    console.log(`[actweb-extract] acct="${accountNum}" cad="${cadRef}" levy="${taxLevy}" totalDue="${totalDue}" tables=${billTables.length}`);

    return {
      ownerName, siteAddress, legalDesc,
      accountNum, cadRef,
      grossVal: fmt(grossVal), landVal: fmt(landVal), impVal: fmt(impVal),
      cappedVal: fmt(cappedVal), agVal: fmt(agVal),
      taxLevy: fmt(taxLevy),
      currentDue: fmt(currentDue), priorDue: fmt(priorDue), totalDue: fmt(totalDue),
      lastPayAmt: fmt(lastPayAmt), lastPayDate,
      billTables, yearHeaders,
      detailUrl: window.location.href,
    };
  }).catch(() => ({
    ownerName: '', siteAddress: '', legalDesc: '',
    accountNum: '', cadRef: '',
    grossVal: '', landVal: '', impVal: '', cappedVal: '', agVal: '',
    taxLevy: '', currentDue: '', priorDue: '', totalDue: '',
    lastPayAmt: '', lastPayDate: '',
    billTables: [], yearHeaders: [], detailUrl: page.url(),
  }));
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function search(page, { accountNumber = '', firstName = '', lastName = '', fullName = '', onProgress = () => {} }) {
  const actBase  = baseFromUrl(page.url());
  const county   = countyFromUrl(page.url());
  const hasAcct  = !!(accountNumber || '').trim();
  const hasName  = !!(lastName || fullName || '').trim();

  if (!hasAcct && !hasName) return null;

  onProgress(`ACTweb: searching ${county} County...`);
  console.log(`[actweb] county=${county} base=${actBase}`);

  try {
    const cap = await detectCaptcha(page);
    if (cap.detected) return { ...cap, searchedUrl: page.url() };

    // ── Strategy 1: account number search ──────────────────────────────────────
    let resultsList = [];

    if (hasAcct) {
      const acctVal = (accountNumber || '').trim();
      console.log(`[actweb] searching by account: "${acctVal}"`);
      const submitted = await submitSearch(page, actBase, acctVal, '4');
      if (submitted) {
        const pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
        if (!/no\s+records?\s+found|no\s+results|0\s+record/i.test(pageText)) {
          resultsList = await extractResultsList(page);
        }
      }
    }

    // ── Strategy 2: full cleaned name search ───────────────────────────────────
    if (!resultsList.length && hasName) {
      const rawName = (lastName || fullName || firstName || '').trim();
      const cleanedName = cleanNameForActweb(rawName);
      console.log(`[actweb] searching by name: "${cleanedName}"`);
      onProgress(`ACTweb: retrying with owner name "${cleanedName}"...`);
      const submitted = await submitSearch(page, actBase, cleanedName, '3');
      if (submitted) {
        const pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
        if (!/no\s+records?\s+found|no\s+results|0\s+record/i.test(pageText)) {
          resultsList = await extractResultsList(page);
        }
      }
    }

    // ── Strategy 3: last name only (first word) ────────────────────────────────
    if (!resultsList.length && hasName) {
      const rawName = (lastName || fullName || firstName || '').trim();
      const lastNameOnly = cleanNameForActweb(rawName).split(' ')[0];
      if (lastNameOnly && lastNameOnly.length >= 2) {
        console.log(`[actweb] searching by last name only: "${lastNameOnly}"`);
        onProgress(`ACTweb: retrying with last name "${lastNameOnly}"...`);
        const submitted = await submitSearch(page, actBase, lastNameOnly, '3');
        if (submitted) {
          const pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
          if (!/no\s+records?\s+found|no\s+results|0\s+record/i.test(pageText)) {
            resultsList = await extractResultsList(page);
          }
        }
      }
    }

    if (!resultsList.length) {
      const searchVal = (accountNumber || lastName || fullName || firstName || '').trim();
      return {
        records: [], totalFound: 0,
        summary: `No records found for "${searchVal}" in ${county} County.`,
        searchedUrl: page.url(),
      };
    }

    // ── Check captcha on results page ──────────────────────────────────────────
    const cap2 = await detectCaptcha(page);
    if (cap2.detected) return { ...cap2, searchedUrl: page.url() };

    // ── Load and extract detail pages ──────────────────────────────────────────
    onProgress('Reading search results...');
    console.log(`[actweb] found ${resultsList.length} results`);

    const records = [];
    for (const item of resultsList.slice(0, 5)) {
      if (!item.detailUrl) continue;

      onProgress(`Loading detail for ${item.acctNum || 'account'}...`);
      console.log(`[actweb] detail URL: ${item.detailUrl}`);

      try {
        await safeGoto(page, item.detailUrl);
        await page.waitForTimeout(1500);

        const d = await extractDetailPage(page);
        const ownerName   = d.ownerName    || item.ownerName    || '';
        const siteAddress = d.siteAddress  || item.siteAddress  || '';
        const acctNum     = d.accountNum   || item.acctNum      || '';
        const totalDue    = d.totalDue     || '';
        const assessedVal = d.grossVal     || d.impVal          || '';

        let paymentStatus = '';
        if (totalDue) {
          paymentStatus = parseFloat(totalDue.replace(/[^0-9.]/g, '')) === 0 ? 'Paid' : 'Balance Due';
        } else if (d.lastPayAmt && parseFloat(d.lastPayAmt.replace(/[^0-9.]/g, '')) > 0) {
          paymentStatus = 'Paid';
        }

        records.push({
          parcelId:        acctNum || item.acctNum,
          ownerName,
          propertyAddress: siteAddress,
          taxAmountDue:    totalDue || d.currentDue || assessedVal,
          taxYear:         '2025',
          paymentStatus,
          county,
          state:           'TX',
          additionalDetails: JSON.stringify({
            'Account Number':    acctNum,
            'CAD Reference No':  d.cadRef         || '',
            'Current Tax Levy':  d.taxLevy        || '',
            'Current Amount Due': d.currentDue    || '',
            'Prior Year Due':    d.priorDue       || '',
            'Total Amount Due':  totalDue         || '',
            'Last Payment':      d.lastPayAmt && d.lastPayDate
                                   ? `${d.lastPayAmt} on ${d.lastPayDate}`
                                   : (d.lastPayAmt || ''),
            'Gross Value':       d.grossVal       || '',
            'Land Value':        d.landVal        || '',
            'Improvement Value': d.impVal         || '',
            'Legal Description': d.legalDesc      || '',
            'Source':            `${county} County Tax Office (ACTweb)`,
            'Detail URL':        d.detailUrl      || item.detailUrl,
            'Bill Tables':       d.billTables     || [],
            'Year Headers':      d.yearHeaders    || [],
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
