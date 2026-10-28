'use strict';

/**
 * Dallas Central Appraisal District (www.dallascad.org) — classic ASP.NET site.
 *
 *   Owner search:   SearchOwner.aspx  → #txtOwnerName + #cmdSubmit
 *   Account search: SearchAcct.aspx   → #txtAcctNum   + #Button1
 *   Results grid:   #SearchResults1_dgResults (# | Address | City | Owner | Total Value | Type)
 *   Detail pages:   AcctDetailRes.aspx / AcctDetailCom.aspx / AcctDetailBPP.aspx?ID=<17-char account>
 */

const BASE = 'https://www.dallascad.org';
const MAX_DETAILS = 5;

async function submit(page, path, inputSel, buttonSel, value) {
  await page.goto(`${BASE}/${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.fill(inputSel, value, { timeout: 10000 });
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}),
    page.click(buttonSel, { timeout: 10000 }),
  ]);
  await page.waitForTimeout(1500);
}

async function readResults(page) {
  return page.evaluate(() => {
    const tbl = document.querySelector('#SearchResults1_dgResults');
    if (!tbl) return { total: 0, rows: [] };
    const m = (tbl.rows[0]?.innerText || '').match(/of\s+([\d,]+)\s+propert/i);
    const rows = [];
    for (const tr of Array.from(tbl.rows)) {
      const a = tr.querySelector('a[href*="AcctDetail"]');
      if (!a) continue;
      const c = Array.from(tr.cells).map(td => (td.innerText || '').replace(/\s+/g, ' ').trim());
      rows.push({ detailUrl: a.href, address: c[1] || '', city: c[2] || '', owner: c[3] || '', totalValue: c[4] || '', type: c[5] || '' });
    }
    return { total: m ? parseInt(m[1].replace(/,/g, ''), 10) : rows.length, rows };
  }).catch(() => ({ total: 0, rows: [] }));
}

async function readDetail(page) {
  return page.evaluate(() => {
    const t = id => (document.getElementById(id)?.innerText || '').replace(/\s+/g, ' ').trim();
    const legal = Array.from(document.querySelectorAll('[id^="LegalDesc1_lblLegal"]'))
      .map(e => (e.innerText || '').trim()).filter(Boolean).join(' ');
    // Owner block is a plain panel under the "Owner" heading, not an id'd label
    const ownerHdr = document.getElementById('lblOwner');
    const ownerBlock = ownerHdr ? (ownerHdr.closest('span, div, td')?.parentElement?.innerText || '') : '';
    return {
      title:        t('lblPageTitle'),
      address:      t('PropAddr1_lblPropAddr'),
      legal,
      deedDate:     t('LegalDesc1_lblSaleDate'),
      apprYear:     (t('ValueSummary1_lblApprYr').match(/\d{4}/) || [''])[0],
      improvement:  t('ValueSummary1_lblImpVal'),
      land:         t('ValueSummary1_pnlValue_lblLandVal'),
      market:       t('ValueSummary1_pnlValue_lblTotalVal'),
      yearBuilt:    t('MainImpRes1_lblYearBuilt'),
      livingArea:   t('MainImpRes1_lblLivingArea'),
      landArea:     t('Land1_dgLand__ctl2_Label1'),
      ownerBlock:   ownerBlock.replace(/Owner \(Current \d{4}\)/i, '').replace(/\s+\n/g, '\n').trim().slice(0, 300),
    };
  }).catch(() => ({}));
}

async function search(page, { accountNumber = '', firstName = '', lastName = '', fullName = '', onProgress = () => {} }) {
  const acct = (accountNumber || '').replace(/[\s-]/g, '').toUpperCase();
  // DCAD owner search wants "LAST FIRST"
  const owner = (lastName ? `${lastName} ${firstName}` : (fullName || firstName)).trim().toUpperCase().slice(0, 25);
  if (!acct && !owner) return null;

  try {
    if (acct) {
      onProgress(`Dallas CAD: searching account ${acct}...`);
      await submit(page, 'SearchAcct.aspx', '#txtAcctNum', '#Button1', acct);
    } else {
      onProgress(`Dallas CAD: searching owner "${owner}"...`);
      await submit(page, 'SearchOwner.aspx', '#txtOwnerName', '#cmdSubmit', owner);
    }

    const { total, rows } = await readResults(page);
    console.log(`[dallascad] ${rows.length} rows (total ${total})`);
    if (!rows.length) {
      return { records: [], totalFound: 0, searchedUrl: page.url(),
        summary: `No Dallas CAD records found for ${acct ? `account ${acct}` : `owner "${owner}"`}.` };
    }

    const records = [];
    for (const row of rows.slice(0, MAX_DETAILS)) {
      const id = (row.detailUrl.match(/ID=([^&]+)/i) || [])[1] || '';
      onProgress(`Dallas CAD: loading account ${id}...`);
      await page.goto(row.detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      const d = await readDetail(page);
      const situs = [d.address || row.address, row.city].filter(Boolean).join(', ');
      records.push({
        parcelId:         id,
        ownerName:        row.owner,
        propertyAddress:  situs ? `${situs}, TX` : '',
        legalDescription: d.legal || '',
        taxAmountDue:     '',
        taxYear:          d.apprYear || '',
        paymentStatus:    '',
        county:           'Dallas',
        state:            'TX',
        additionalDetails: JSON.stringify({
          accountType:       row.type,
          marketValue:       d.market || row.totalValue,
          appraisedValue:    d.market || row.totalValue,
          landMarketValue:   d.land || '',
          improvementValue:  d.improvement || '',
          legalDescription:  d.legal || '',
          deedTransferDate:  d.deedDate || '',
          yearBuilt:         d.yearBuilt || '',
          livingArea:        d.livingArea || '',
          landArea:          d.landArea || '',
          ownerAndMailing:   d.ownerBlock || '',
          detailPageUrl:     row.detailUrl,
        }),
      });
    }

    return {
      records,
      totalFound: total,
      summary: `Found ${total} total, showing first ${records.length} record(s) for ${acct || owner} (Dallas CAD).`,
      searchedUrl: `${BASE}/${acct ? 'SearchAcct.aspx' : 'SearchOwner.aspx'}`,
    };
  } catch (err) {
    console.log(`[dallascad] error: ${err.message}`);
    return null;
  }
}

module.exports = { search };
