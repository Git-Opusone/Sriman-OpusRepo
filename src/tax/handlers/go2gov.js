'use strict';

const { detectCaptcha } = require('../../shared/captchaDetector');

// Go2Gov TX county tax portals:
//   https://camerontax.go2gov.net/cameron/cart/search/quickSearch.do
//   https://webb.go2gov.net/webb/cart/search/quickSearch.do
//
// Single unified search box — accepts Account #, Billing #, Name, Situs Address.
// Result links call doShowAccountPage(acctNum) → navigates to /faces/accountSummary.jsp
// Year detail at: /faces/_rlvid.jsp?_rap=!accountDetail&_rvip=/accountSummary.jsp&year=YYYY

function countyFromUrl(url) {
  try {
    const u = new URL(url);
    // path: /cameron/cart/...  or hostname camerontax → extract "cameron"
    const pathSeg = u.pathname.split('/').filter(Boolean)[0];
    if (pathSeg && pathSeg !== 'cart' && pathSeg !== 'faces') {
      return pathSeg.charAt(0).toUpperCase() + pathSeg.slice(1);
    }
    const hostSeg = u.hostname.split('.')[0].replace(/tax$/, '');
    return hostSeg.charAt(0).toUpperCase() + hostSeg.slice(1);
  } catch (_) { return 'TX'; }
}

function searchBaseFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const searchIdx = parts.indexOf('search');
    const basePath  = searchIdx >= 0
      ? '/' + parts.slice(0, searchIdx + 1).join('/')
      : '/' + parts[0] + '/cart/search';
    return `${u.protocol}//${u.host}${basePath}`;
  } catch (_) { return url; }
}

function facesBaseFromUrl(url) {
  try { return `${new URL(url).protocol}//${new URL(url).host}/faces`; }
  catch (_) { return ''; }
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

// ─── Submit quickSearch.do form ───────────────────────────────────────────────

async function submitSearch(page, searchBase, searchValue) {
  const searchUrl = `${searchBase}/quickSearch.do`;
  console.log(`[go2gov] navigating to ${searchUrl}`);
  await safeGoto(page, searchUrl, 25000);
  await page.waitForTimeout(1500);

  // Try showNameSearch.do as fallback URL if quickSearch returns a motor-vehicle page
  const pageText0 = await page.evaluate(() => (document.body?.innerText || '').toLowerCase()).catch(() => '');
  if (/motor\s*vehicle|vehicle\s*renewal/i.test(pageText0) && !/property\s*tax|account\s*number|owner\s*name/i.test(pageText0)) {
    console.log('[go2gov] quickSearch landed on motor-vehicle page, trying showNameSearch.do');
    await safeGoto(page, `${searchBase}/showNameSearch.do`, 25000);
    await page.waitForTimeout(1500);
  }

  // Unified input selectors (quickSearch has a single text box)
  const INPUT_SELECTORS = [
    'input[name="quickSearchTxt"]',
    'input[name="criteria"]',
    'input[placeholder*="Search" i]',
    'input[placeholder*="Name" i]',
    'input[placeholder*="Account" i]',
    'input[type="text"]',
    '#criteria',
    '#quickSearchTxt',
    '#searchCriteria',
  ];

  let filled = false;
  for (const sel of INPUT_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.count({ timeout: 2000 }) > 0 && await el.isVisible({ timeout: 2000 })) {
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

  // Submit (quickSearch has a button labelled "QSubmit" or similar)
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 25000 }).catch(() => {}),
      page.keyboard.press('Enter'),
    ]);
    await page.waitForTimeout(2000);
  } catch (_) {
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 25000 }).catch(() => {}),
        page.click('input[type="submit"], button[type="submit"], button:has-text("Submit")', { timeout: 4000 }),
      ]);
      await page.waitForTimeout(2000);
    } catch (_2) {}
  }

  console.log(`[go2gov] post-submit URL: ${page.url()}`);
  return true;
}

// ─── Parse search results table ───────────────────────────────────────────────
// Columns: Select to Pay | View Details | Account Number | Owner Name | Location Address | Total Tax Due

async function extractResults(page) {
  return page.evaluate(() => {
    const results = [];
    const tables  = Array.from(document.querySelectorAll('table'));

    for (const tbl of tables) {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      if (rows.length < 2) continue;

      // Find the header row
      const headerRow = rows.find(r => {
        const txt = (r.innerText || '').toLowerCase();
        return txt.includes('account') || txt.includes('owner') || txt.includes('name');
      });
      if (!headerRow) continue;

      const headers  = Array.from(headerRow.querySelectorAll('th, td'))
        .map(c => (c.innerText || '').trim().toLowerCase());
      const acctIdx  = headers.findIndex(h => h.includes('account'));
      const ownerIdx = headers.findIndex(h => h.includes('owner') || (h.includes('name') && !h.includes('account')));
      const addrIdx  = headers.findIndex(h => h.includes('address') || h.includes('location') || h.includes('situs'));
      const dueIdx   = headers.findIndex(h => h.includes('due') || h.includes('tax'));

      for (const row of rows) {
        if (row === headerRow) continue;
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 2) continue;

        // Account number link — Go2Gov uses doShowAccountPage() JS or a plain link
        const acctLink = row.querySelector('a[href*="doShowAccountPage"], a[href*="accountSummary"], td a');
        const ct  = cells.map(c => (c.innerText || '').trim());

        let acctNum   = acctIdx  >= 0 ? ct[acctIdx]  || '' : '';
        let ownerName = ownerIdx >= 0 ? ct[ownerIdx] || '' : '';
        let siteAddr  = addrIdx  >= 0 ? ct[addrIdx]  || '' : '';
        let totalDue  = dueIdx   >= 0 ? ct[dueIdx]   || '' : '';

        // Prefer link text for account number
        if (acctLink) {
          const linkText = (acctLink.innerText || '').trim();
          if (linkText && /^\d/.test(linkText)) acctNum = linkText;
        }

        // Extract doShowAccountPage argument for direct navigation
        let jsAcct = '';
        for (const a of Array.from(row.querySelectorAll('a'))) {
          const href = a.getAttribute('href') || '';
          const m    = href.match(/doShowAccountPage\(['"]?([^'")\s]+)['"]?\)/i);
          if (m) { jsAcct = m[1]; break; }
        }

        if (acctNum || jsAcct) {
          results.push({ acctNum: acctNum || jsAcct, jsAcct, ownerName, siteAddr, totalDue });
        }
      }
      if (results.length) break;
    }

    // Also try: "View Details" icon links (second column) which may have the account in data-* or href
    if (!results.length) {
      const detailLinks = Array.from(document.querySelectorAll('a[href*="doShowAccountPage"]'));
      for (const a of detailLinks) {
        const href = a.getAttribute('href') || '';
        const m    = href.match(/doShowAccountPage\(['"]?([^'")\s]+)['"]?\)/i);
        if (!m) continue;
        const row  = a.closest('tr');
        const cells = row ? Array.from(row.querySelectorAll('td')) : [];
        const ct    = cells.map(c => (c.innerText || '').trim());
        results.push({
          acctNum: m[1], jsAcct: m[1],
          ownerName: ct[3] || ct[2] || '', siteAddr: ct[4] || ct[3] || '', totalDue: ct[5] || ct[4] || '',
        });
      }
    }
    return results;
  }).catch(() => []);
}

// ─── Navigate to account detail via doShowAccountPage() ──────────────────────
// Clicks the account number link; Go2Gov's JS sets a hidden form & submits to accountSummary.jsp

async function navigateToDetail(page, item, facesBase) {
  // Strategy 1: click the account number link directly (triggers doShowAccountPage JS)
  try {
    const acctLinkSel = item.jsAcct
      ? `a[href*="doShowAccountPage"][href*="${item.jsAcct}"]`
      : `a:has-text("${item.acctNum}")`;
    const link = page.locator(acctLinkSel).first();
    if (await link.count({ timeout: 2000 }) > 0) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {}),
        link.click({ timeout: 5000 }),
      ]);
      await page.waitForTimeout(1500);
      if (page.url().includes('accountSummary') || page.url().includes('faces')) {
        console.log(`[go2gov] navigated to detail via link click: ${page.url()}`);
        return true;
      }
    }
  } catch (_) {}

  // Strategy 2: evaluate doShowAccountPage() directly if the function exists on window
  if (item.jsAcct) {
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {}),
        page.evaluate(acct => {
          if (typeof doShowAccountPage === 'function') doShowAccountPage(acct);
        }, item.jsAcct),
      ]);
      await page.waitForTimeout(1500);
      if (page.url().includes('accountSummary') || page.url().includes('faces')) {
        console.log(`[go2gov] navigated via JS eval: ${page.url()}`);
        return true;
      }
    } catch (_) {}
  }

  // Strategy 3: direct URL to accountSummary.jsp (requires session — may fail on first attempt)
  if (facesBase && item.jsAcct) {
    try {
      await safeGoto(page, `${facesBase}/accountSummary.jsp`, 15000);
      if (page.url().includes('accountSummary')) {
        console.log(`[go2gov] navigated to accountSummary.jsp directly: ${page.url()}`);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// ─── Extract data from accountSummary.jsp ────────────────────────────────────

async function extractAccountSummary(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';

    // Ownership table: Account #, Owner Name, Mailing Address, Legal Description
    let acctNum = '', ownerName = '', mailingAddr = '', legalDesc = '';
    const tables = Array.from(document.querySelectorAll('table'));
    for (const tbl of tables) {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      const header = rows[0] ? (rows[0].innerText || '').toLowerCase() : '';
      if (!header.includes('account') && !header.includes('owner')) continue;

      const hCells = Array.from(rows[0].querySelectorAll('th, td')).map(c => (c.innerText || '').trim().toLowerCase());
      const acctI  = hCells.findIndex(h => h.includes('account'));
      const ownI   = hCells.findIndex(h => h.includes('owner'));
      const addrI  = hCells.findIndex(h => h.includes('mailing') || h.includes('address'));
      const legalI = hCells.findIndex(h => h.includes('legal'));

      for (let ri = 1; ri < rows.length; ri++) {
        const cells = Array.from(rows[ri].querySelectorAll('td'));
        const ct    = cells.map(c => (c.innerText || '').replace(/\s+/g, ' ').trim());
        if (ct.length < 2) continue;
        if (acctI  >= 0 && ct[acctI])  acctNum    = ct[acctI];
        if (ownI   >= 0 && ct[ownI])   ownerName  = ct[ownI];
        if (addrI  >= 0 && ct[addrI])  mailingAddr = ct[addrI];
        if (legalI >= 0 && ct[legalI]) legalDesc   = ct[legalI];
        break;
      }
      if (acctNum) break;
    }

    // Tax year summary table: Tax Year | Base Due | Penalty | Attorney Fees | Total
    const billTables   = [];
    const yearHeaders  = [];
    let   totalDue     = '';
    let   currentYearLink = ''; // href of the current year link (for detail page)

    for (const tbl of tables) {
      const rows  = Array.from(tbl.querySelectorAll('tr'));
      const flat  = rows.map(r =>
        Array.from(r.querySelectorAll('td, th')).map(c => (c.innerText || '').replace(/\s+/g, ' ').trim())
      ).filter(r => r.some(c => c.length > 0));

      if (flat.length < 2) continue;
      const hasMoney = flat.some(r => r.some(c => /\$[\d,]+/.test(c) || /[\d,]+\.\d{2}/.test(c)));
      const hasTax   = flat.some(r => r.some(c => /tax|due|paid|base|total|penalty/i.test(c)));
      if (!hasMoney && !hasTax) continue;

      billTables.push(flat);

      // Try to grab total from the table
      for (const row of flat) {
        if (/total/i.test(row[0] || '') || /total/i.test(row[row.length-2] || '')) {
          const last = row[row.length - 1] || '';
          if (/\$[\d,]+/.test(last)) { totalDue = last; break; }
        }
      }

      // Year headers from text or first data cell
      const yrM = flat.flatMap(r => r).join(' ').match(/\b((?:19|20)\d{2})\b/);
      yearHeaders.push(yrM ? yrM[1] : '');

      // Current year link (clicking it opens _rlvid.jsp year detail)
      const yearLinks = Array.from(tbl.querySelectorAll('a[href*="year"], a[href*="_rlvid"]'));
      if (yearLinks.length && !currentYearLink) currentYearLink = yearLinks[0].href;
    }

    // Fallback: regex total from page text
    if (!totalDue) {
      const m = text.match(/Total\s+Tax\s+Due[:\s]*\$?([\d,]+\.?\d*)/i)
             || text.match(/Total[:\s]+\$?([\d,]+\.?\d*)/i);
      if (m) totalDue = `$${m[1]}`;
    }

    const siteAddress = text.match(/(?:Site|Situs|Location)\s+Address[:\s]+([^\n\r]{5,80})/i)?.[1]?.trim() || '';

    console.log(`[go2gov-summary] acct="${acctNum}" owner="${ownerName}" totalDue="${totalDue}" tables=${billTables.length}`);
    return { acctNum, ownerName, mailingAddr, siteAddress, legalDesc, totalDue, billTables, yearHeaders, currentYearLink, detailUrl: window.location.href };
  }).catch(() => ({
    acctNum: '', ownerName: '', mailingAddr: '', siteAddress: '', legalDesc: '',
    totalDue: '', billTables: [], yearHeaders: [], currentYearLink: '', detailUrl: page.url(),
  }));
}

// ─── Extract year detail from _rlvid.jsp (taxing-unit breakdown) ─────────────

async function extractYearDetail(page, currentYearLink) {
  if (!currentYearLink) return null;
  try {
    await safeGoto(page, currentYearLink, 20000);
    await page.waitForTimeout(1500);

    return await page.evaluate(() => {
      const tables   = [];
      const yrHeaders = [];
      let totalDue   = '';

      for (const tbl of Array.from(document.querySelectorAll('table'))) {
        const rows = Array.from(tbl.querySelectorAll('tr'));
        const flat = rows
          .map(r => Array.from(r.querySelectorAll('td, th')).map(c => (c.innerText || '').replace(/\s+/g, ' ').trim()))
          .filter(r => r.some(c => c.length > 0));
        if (flat.length < 2) continue;
        const hasMoney = flat.some(r => r.some(c => /\$[\d,]+/.test(c) || /[\d,]+\.\d{2}/.test(c)));
        const hasTaxing = flat.some(r => r.some(c => /taxing\s*unit|isd|county|city|district/i.test(c)));
        if (!hasMoney && !hasTaxing) continue;
        tables.push(flat);
        const yrM = (tbl.innerText || '').match(/\b((?:19|20)\d{2})\b/);
        yrHeaders.push(yrM ? yrM[1] : '');

        // Total row
        const lastRow = flat[flat.length - 1] || [];
        if (/total/i.test(lastRow[0] || '')) {
          const last = lastRow[lastRow.length - 1] || '';
          if (/\$[\d,]+/.test(last)) totalDue = last;
        }
      }
      return { billTables: tables, yearHeaders: yrHeaders, totalDue };
    }).catch(() => null);
  } catch (_) { return null; }
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function search(page, { accountNumber = '', firstName = '', lastName = '', fullName = '', onProgress = () => {} }) {
  const currentUrl = page.url();
  const county     = countyFromUrl(currentUrl);
  const searchBase = searchBaseFromUrl(currentUrl);
  const facesBase  = facesBaseFromUrl(currentUrl);

  const hasAcct = !!(accountNumber || '').trim();
  const hasName = !!(lastName || fullName || firstName || '').trim();
  if (!hasAcct && !hasName) return null;

  onProgress(`Go2Gov: searching ${county} County...`);
  console.log(`[go2gov] county=${county} searchBase=${searchBase}`);

  try {
    const cap = await detectCaptcha(page);
    if (cap.detected) return { ...cap, searchedUrl: page.url() };

    // Prefer name search for Go2Gov — account IDs in our system rarely match
    // Go2Gov's 16-digit internal account numbers directly.
    // If account number matches Go2Gov format (long numeric), try it first.
    const acctTrimmed = (accountNumber || '').trim();
    const isGo2GovAcct = /^\d{13,}$/.test(acctTrimmed);  // 13+ digit = Go2Gov format

    let searchValue = '';
    let usedAcct = false;

    if (isGo2GovAcct) {
      searchValue = acctTrimmed;
      usedAcct    = true;
    } else if (hasName) {
      // Use full name if available (CAD names are typically "LASTNAME FIRSTNAME")
      searchValue = (lastName || fullName || firstName || '').trim().toUpperCase();
    } else {
      searchValue = acctTrimmed;
      usedAcct    = true;
    }

    console.log(`[go2gov] searching with: "${searchValue}" (usedAcct=${usedAcct})`);
    const submitted = await submitSearch(page, searchBase, searchValue);
    if (!submitted) return null;

    // Check for no results
    const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (/no\s+(?:records?|results?)\s+found|0\s+record|no\s+properties\s+found/i.test(bodyText)) {
      // If account search found nothing, retry with name
      if (usedAcct && hasName) {
        const nameFallback = (lastName || fullName || firstName || '').trim().toUpperCase();
        console.log(`[go2gov] account search empty — retrying with name: "${nameFallback}"`);
        onProgress(`Go2Gov: retrying with name "${nameFallback}"...`);
        const submitted2 = await submitSearch(page, searchBase, nameFallback);
        if (!submitted2) return null;
        const body2 = await page.evaluate(() => document.body.innerText || '').catch(() => '');
        if (/no\s+(?:records?|results?)\s+found|0\s+record/i.test(body2)) {
          return { records: [], totalFound: 0, summary: `No records found for "${nameFallback}" in ${county} County.`, searchedUrl: page.url() };
        }
      } else {
        return { records: [], totalFound: 0, summary: `No records found for "${searchValue}" in ${county} County.`, searchedUrl: page.url() };
      }
    }

    const cap2 = await detectCaptcha(page);
    if (cap2.detected) return { ...cap2, searchedUrl: page.url() };

    onProgress('Reading search results...');
    let resultsList = await extractResults(page);
    console.log(`[go2gov] found ${resultsList.length} results`);

    // If name search returned 0 (table parse failed), check if we're already on accountSummary
    if (!resultsList.length && page.url().includes('accountSummary')) {
      console.log('[go2gov] already on accountSummary page');
      resultsList = [{ acctNum: '', jsAcct: '', ownerName: '', siteAddr: '', totalDue: '', _alreadyOnDetail: true }];
    }

    if (!resultsList.length) return null;

    const records = [];
    const MAX     = 5;
    const searchResultsUrl = page.url();

    for (const item of resultsList.slice(0, MAX)) {
      try {
        let detailOk = false;

        if (item._alreadyOnDetail) {
          detailOk = true;
        } else {
          // Navigate back to results if needed
          if (!page.url().includes('quickSearch') && !page.url().includes('showNameSearch') && !page.url().includes(searchResultsUrl)) {
            await safeGoto(page, searchResultsUrl, 15000).catch(() => {});
            await page.waitForTimeout(1000);
          }
          onProgress(`Loading detail for ${item.acctNum || 'account'}...`);
          detailOk = await navigateToDetail(page, item, facesBase);
        }

        if (!detailOk) {
          console.log(`[go2gov] could not navigate to detail for ${item.acctNum}`);
          continue;
        }

        await page.waitForTimeout(1500);
        const summary = await extractAccountSummary(page);

        // Try to get year detail (taxing unit breakdown)
        let yearDetail = null;
        if (summary.currentYearLink) {
          onProgress('Loading tax year detail...');
          yearDetail = await extractYearDetail(page, summary.currentYearLink);
          // Navigate back to summary for next iteration
          await safeGoto(page, summary.detailUrl, 10000).catch(() => {});
          // Navigate back to results for next item
          await safeGoto(page, searchResultsUrl, 10000).catch(() => {});
        }

        const ownerName   = summary.ownerName   || item.ownerName   || '';
        const siteAddress = summary.siteAddress  || summary.mailingAddr || item.siteAddr || '';
        const acctNum     = summary.acctNum      || item.acctNum     || '';
        const totalDue    = (yearDetail?.totalDue || summary.totalDue || item.totalDue || '').trim();

        // Merge bill tables
        const billTables  = (yearDetail?.billTables?.length  ? yearDetail.billTables  : summary.billTables)  || [];
        const yearHeaders = (yearDetail?.yearHeaders?.length ? yearDetail.yearHeaders : summary.yearHeaders) || [];

        let paymentStatus = '';
        if (totalDue) {
          const amt = parseFloat(totalDue.replace(/[^0-9.]/g, ''));
          paymentStatus = isNaN(amt) ? '' : amt === 0 ? 'Paid' : 'Balance Due';
        }

        records.push({
          parcelId:        acctNum || item.acctNum,
          ownerName,
          propertyAddress: siteAddress,
          taxAmountDue:    totalDue,
          taxYear:         yearHeaders[0] || new Date().getFullYear().toString(),
          paymentStatus,
          county,
          state:           'TX',
          additionalDetails: JSON.stringify({
            'Account Number':    acctNum,
            'Total Taxes Due':   totalDue,
            'Mailing Address':   summary.mailingAddr || '',
            'Legal Description': summary.legalDesc   || '',
            'Source':            `${county} County Tax Office (Go2Gov)`,
            'Detail URL':        summary.detailUrl   || '',
            'Bill Tables':       billTables,
            'Year Headers':      yearHeaders,
          }),
        });
      } catch (e) {
        console.log(`[go2gov] detail error for ${item.acctNum}: ${e.message}`);
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
