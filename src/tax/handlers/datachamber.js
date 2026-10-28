'use strict';

/**
 * Shared CAD website template ("data_chamber_table"), hosted on 66.172.59.197 and
 * used by ~66 small TX appraisal districts (DeWitt, Marion, Throckmorton,
 * Armstrong, Crockett, King, Loving, …). Detected by HTML fingerprint since
 * every county has its own domain.
 *
 *   Search:  /Home/Search?SearchOption=basic&Keyword=<LAST FIRST | property id>
 *            → #id_search_list (DataTables, filled by AJAX)
 *   Detail:  /Home/Details?parcelId=<id>&ownershipId=<id>
 *            → owner, legal, values, taxing jurisdictions + rates, value history
 */

const MAX_DETAILS = 5;

async function readResults(page) {
  await page.waitForSelector('#id_search_list tbody tr td', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1000);
  return page.evaluate(() => {
    const t = document.querySelector('#id_search_list');
    if (!t) return { total: 0, rows: [] };
    const hdr = Array.from(t.querySelectorAll('thead th')).map(th => th.innerText.trim().toLowerCase());
    const col = name => hdr.indexOf(name);
    const rows = Array.from(t.querySelectorAll('tbody tr')).map(tr => {
      const c = Array.from(tr.cells).map(td => (td.innerText || '').replace(/\s+/g, ' ').trim());
      const a = tr.querySelector('a[href*="Details"]');
      return {
        id: c[col('parcel id')] || '', geoId: c[col('account')] || '', owner: c[col('owner name')] || '',
        mailing: c[col('address')] || '', situs: c[col('property address')] || '', legal: c[col('legal')] || '',
        market: c[col('market value')] || '', detailUrl: a ? a.href : '',
      };
    }).filter(r => r.id && r.detailUrl);
    const m = ((document.querySelector('.dataTables_info') || {}).innerText || '').match(/of\s+([\d,]+)\s+entries/i);
    return { total: m ? parseInt(m[1].replace(/,/g, ''), 10) : rows.length, rows };
  }).catch(() => ({ total: 0, rows: [] }));
}

async function readDetail(page) {
  return page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ');
    const grab = re => ((t.match(re) || [])[1] || '').trim();
    const num = s => parseFloat(String(s).replace(/[^0-9.]/g, '')) || 0;
    const usd = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const tables = Array.from(document.querySelectorAll('table'));
    const rowsOf = tbl => Array.from(tbl.rows).map(r => Array.from(r.cells).map(c => (c.innerText || '').replace(/\s+/g, ' ').trim()));

    // Entity | Description | Tax Rate | Market Value | Taxable Value  (rate is per $100)
    const jTbl = tables.find(tb => /tax rate/i.test(tb.rows[0]?.innerText || '') && /entity/i.test(tb.rows[0]?.innerText || ''));
    const taxingUnits = jTbl ? rowsOf(jTbl).slice(1).filter(r => r.length >= 5 && r[1]).map(r => ({
      code: r[0], name: r[1], ratePer100: r[2], taxableValue: r[4],
      estimatedTax: usd(num(r[4]) * num(r[2]) / 100),
    })) : [];

    const hTbl = tables.find(tb => /improvements/i.test(tb.rows[0]?.innerText || '') && /year/i.test(tb.rows[0]?.innerText || ''));
    const valueHistory = hTbl ? rowsOf(hTbl).slice(1).filter(r => /^\d{4}$/.test(r[0])).map(r => ({
      year: r[0], improvements: r[1], land: r[2], marketValue: r[6] || '', appraised: r[r.length - 1] || '',
    })) : [];

    const total = taxingUnits.reduce((s, u) => s + num(u.estimatedTax), 0);
    return {
      year:        grab(/Values shown are (\d{4})/) || grab(/For Year (\d{4})/),
      legal:       grab(/Legal Description (.+?) Additional Legal/) || grab(/Legal Description (.+?) Geographic ID/),
      geoId:       grab(/Geographic ID (\S+)/),
      ownerName:   grab(/OWNER Owner ID \S+ Name (.+?) Care of/),
      mailing:     grab(/Mailing Address (.+?) % Ownership/),
      exemptions:  grab(/Exemptions (.+?) Show Map/),
      situs:       grab(/LOCATION Location (.+?) Neighborhood/),
      acres:       grab(/Total Acres ([\d.]+)/),
      improvement: num(grab(/Improvement Hs ([\d,]+)/)) + num(grab(/Improvement Nhs ([\d,]+)/)),
      land:        num(grab(/Land Hs ([\d,]+)/)) + num(grab(/Land Nhs ([\d,]+)/)),
      market:      grab(/Market Value ([\d,]+) Land Market/),
      appraised:   grab(/Appraised Value ([\d,]+)/),
      taxingUnits,
      valueHistory,
      estimatedTotalTax: total ? usd(total) : '',
    };
  }).catch(() => ({}));
}

async function search(page, { accountNumber = '', firstName = '', lastName = '', fullName = '', onProgress = () => {} }) {
  let origin;
  try { origin = new URL(page.url()).origin; } catch (_) { return null; }
  const acct = (accountNumber || '').trim();
  // Site hint: "owner name (LASTNAME FIRSTNAME)"
  const name = (lastName ? `${lastName} ${firstName}` : (fullName || firstName)).trim().toUpperCase();
  const q = acct || name;
  if (!q) return null;

  try {
    onProgress(`CAD search: looking up "${q}"...`);
    const searchUrl = `${origin}/Home/Search?SearchOption=basic&Keyword=${encodeURIComponent(q)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    let { total, rows } = await readResults(page);
    console.log(`[datachamber] ${origin} q="${q}" → ${rows.length} rows (total ${total})`);
    // Keyword search is a "contains" match ("187" → 917 rows); keep the exact ID hit
    if (acct) {
      const exact = rows.filter(r => r.id === acct || r.geoId === acct);
      if (exact.length) { rows = exact; total = exact.length; }
    }
    if (!rows.length) {
      return { records: [], totalFound: 0, searchedUrl: searchUrl, summary: `No records found for "${q}".` };
    }

    const dollars = v => (v && /^\d[\d,]*$/.test(v) ? `$${v}` : v || '');
    const records = [];
    for (const row of rows.slice(0, MAX_DETAILS)) {
      onProgress(`CAD search: loading property ${row.id}...`);
      await page.goto(row.detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      // Values and jurisdiction tables arrive by AJAX after the headings render;
      // wait for a real tax-rate figure (e.g. "0.3557600")
      await page.waitForFunction(() => /Improvement Hs [\d,]+/.test(document.body.innerText.replace(/\s+/g, ' '))
        && /\b\d\.\d{5,}\b/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
      const d = await readDetail(page);
      records.push({
        parcelId:         row.id,
        ownerName:        d.ownerName || row.owner,
        propertyAddress:  d.situs || row.situs,
        legalDescription: d.legal || row.legal,
        taxAmountDue:     d.estimatedTotalTax || '',
        taxYear:          d.year || '',
        paymentStatus:    '',
        county:           '',
        state:            'TX',
        additionalDetails: JSON.stringify({
          geoId:             d.geoId || row.geoId,
          mailingAddress:    d.mailing || row.mailing,
          exemptions:        d.exemptions || '',
          legalAcreage:      d.acres || '',
          marketValue:       dollars(d.market || row.market),
          appraisedValue:    dollars(d.appraised || d.market || row.market),
          landMarketValue:   d.land ? `$${d.land.toLocaleString('en-US')}` : '',
          improvementValue:  d.improvement ? `$${d.improvement.toLocaleString('en-US')}` : '',
          legalDescription:  d.legal || row.legal,
          taxingUnits:       d.taxingUnits || [],
          valueHistory:      d.valueHistory || [],
          estimatedTotalTax: d.estimatedTotalTax || '',
          detailPageUrl:     row.detailUrl,
        }),
      });
    }

    return {
      records,
      totalFound: total,
      summary: `Found ${total} total, showing first ${records.length} record(s) for ${q} (CAD website).`,
      searchedUrl: searchUrl,
    };
  } catch (err) {
    console.log(`[datachamber] error: ${err.message}`);
    return null;
  }
}

module.exports = { search };
