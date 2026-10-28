'use strict';

/**
 * Tyler "PublicAccess" CAD search (DNN + Kendo grid), e.g. search.wcad.org
 * (Williamson CAD). Same page template as the TX county tax offices handled by
 * andersontax.js, but that handler strips zero-padding from IDs (R024017 →
 * R24017), which a CAD search does not accept, so CADs get this handler.
 *
 *   Search:  /Property-Search-Result/searchtext/<name | property id>
 *   Grid:    .k-grid-table — PROPERTY ID | OWNER NAME | SITUS | LEGAL | MARKET VALUE
 *   Detail:  /Property-Detail/PropertyQuickRefID/<property id>
 */

const MAX_DETAILS = 5;

async function readGrid(page) {
  // The "No properties found" text is in the grid template before data loads,
  // so wait for real rows; an empty search simply times out to [].
  await page.waitForSelector('.k-grid-table tr', { timeout: 25000 }).catch(() => {});
  return page.evaluate(() => {
    // Kendo renders an empty header grid first; the data grid is the one with rows
    const grid = Array.from(document.querySelectorAll('.k-grid-table')).sort((a, b) => b.rows.length - a.rows.length)[0];
    if (!grid) return [];
    // Row cells include hidden columns: ID | Account | Owner ID | Owner | Mailing | Situs |
    // Legal | Map | … | Type | Assessed | Market
    return Array.from(grid.rows).map(r => {
      const c = Array.from(r.cells).map(td => (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim());
      return { id: c[0] || '', account: c[1] || '', owner: c[3] || '', mailing: c[4] || '', situs: c[5] || '',
               legal: c[6] || '', type: c[10] || '', value: c[12] || c[11] || '' };
    }).filter(r => /^[A-Z0-9-]{3,}$/i.test(r.id));
  }).catch(() => []);
}

async function readDetail(page) {
  return page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ');
    const grab = re => ((t.match(re) || [])[1] || '').trim();
    const entities = grab(/TAX RATE PER 100\s+(.+?)\s+\d{4} IMPROVEMENTS/);
    return {
      year:          grab(/(\d{4}) GENERAL INFORMATION/),
      propertyType:  grab(/Property Type\s+(.+?)\s+Legal Description/),
      legal:         grab(/Legal Description\s+(.+?)\s+Neighborhood/),
      account:       grab(/Account\s+(\S+)/),
      ownerName:     grab(/Owner Name\s+(.+?)\s+Owner ID/),
      mailing:       grab(/Mailing Address\s+(.+?)\s+Agent/),
      marketValue:   grab(/Total Market Value\s+(\$[\d,]+)/),
      landValue:     grab(/Total Land Market Value\s+(\$[\d,]+)/),
      imprValue:     grab(/Total Improvement Market Value\s+(\$[\d,]+)/),
      appraised:     grab(/Total Appraised Value\s+(\$[\d,]+)/),
      // "CAD- Williamson CAD N/A N/A N/A GWI- Williamson CO …" → entity names
      taxingUnits:   (entities.match(/[A-Z0-9]{2,4}- .+?(?= N\/A| \$| [\d,]+ |$)/g) || []).map(s => s.trim()),
    };
  }).catch(() => ({}));
}

async function search(page, { accountNumber = '', firstName = '', lastName = '', fullName = '', onProgress = () => {} }) {
  let origin;
  try { origin = new URL(page.url()).origin; } catch (_) { return null; }
  const acct = (accountNumber || '').trim().toUpperCase();
  const name = (lastName ? `${lastName} ${firstName}` : (fullName || firstName)).trim().toUpperCase();
  const q = acct || name;
  if (!q) return null;

  try {
    onProgress(`Tyler PublicAccess: searching "${q}"...`);
    const searchUrl = `${origin}/Property-Search-Result/searchtext/${encodeURIComponent(q)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const rows = await readGrid(page);
    console.log(`[tylerpa] ${origin} q="${q}" → ${rows.length} rows`);
    if (!rows.length) {
      return { records: [], totalFound: 0, searchedUrl: searchUrl, summary: `No properties found for "${q}".` };
    }

    const records = [];
    for (const row of rows.slice(0, MAX_DETAILS)) {
      const detailUrl = `${origin}/Property-Detail/PropertyQuickRefID/${encodeURIComponent(row.id)}`;
      onProgress(`Tyler PublicAccess: loading ${row.id}...`);
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForFunction(() => /GENERAL INFORMATION/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
      const d = await readDetail(page);
      const market = d.marketValue || (/\$/.test(row.value) ? row.value : '');
      records.push({
        parcelId:         row.id,
        ownerName:        d.ownerName || row.owner,
        propertyAddress:  row.situs,
        legalDescription: d.legal || row.legal,
        taxAmountDue:     '',
        taxYear:          d.year || '',
        paymentStatus:    '',
        county:           '',
        state:            'TX',
        additionalDetails: JSON.stringify({
          account:          d.account || '',
          propertyType:     d.propertyType || '',
          mailingAddress:   d.mailing || '',
          marketValue:      market,
          appraisedValue:   d.appraised || market,
          landMarketValue:  d.landValue || '',
          improvementValue: d.imprValue || '',
          legalDescription: d.legal || row.legal,
          taxingUnits:      d.taxingUnits || [],
          detailPageUrl:    detailUrl,
        }),
      });
    }

    return {
      records,
      totalFound: rows.length,
      summary: `Found ${rows.length} record(s) on the first results page, showing ${records.length} for ${q} (Tyler PublicAccess).`,
      searchedUrl: searchUrl,
    };
  } catch (err) {
    console.log(`[tylerpa] error: ${err.message}`);
    return null;
  }
}

module.exports = { search };
