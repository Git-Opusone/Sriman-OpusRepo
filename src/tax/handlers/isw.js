'use strict';

/**
 * Southwest Data Solutions legacy "webindex" CAD portals (ISW), used by ~15 TX
 * counties: iswdataclient.azurewebsites.net/webindex.aspx?dbkey=<COUNTY>CAD
 * (also www.southwestdatasolution.com/webindex.aspx?dbkey=...).
 *
 *   Owner search: webSearchName.aspx?dbkey=<K>&stype=name&sdata=<LAST>
 *   Detail:       webProperty.aspx?dbkey=<K>&id=<Property ID>
 *
 * Detail pages carry ownership, legal/situs, values by year, deed history and
 * an estimated-tax table per taxing entity.
 */

const MAX_DETAILS = 5;

function portal(url) {
  try {
    const u = new URL(url);
    const dbkey = [...u.searchParams].find(([k]) => k.toLowerCase() === 'dbkey')?.[1];
    return dbkey ? { origin: u.origin, dbkey: dbkey.toUpperCase() } : null;
  } catch (_) { return null; }
}

async function readResults(page) {
  return page.evaluate(() => {
    // Results sit inside layout tables whose first row also mentions "Property ID",
    // so require a header *cell* that is exactly "Property ID".
    const tbl = Array.from(document.querySelectorAll('table')).find(t =>
      Array.from(t.rows[0]?.cells || []).some(c => (c.innerText || '').trim().toLowerCase() === 'property id'));
    if (!tbl) return [];
    const hdr = Array.from(tbl.rows[0].cells).map(c => (c.innerText || '').trim().toLowerCase());
    const col = name => hdr.findIndex(h => h.includes(name));
    const [iId, iGeo, iOwner, iAddr, iLegal] = [col('property id'), col('geographic'), col('owner'), col('address'), col('legal')];
    return Array.from(tbl.rows).slice(1).map(r => {
      const c = Array.from(r.cells).map(td => (td.innerText || '').replace(/\s+/g, ' ').trim());
      return { id: c[iId] || '', geoId: c[iGeo] || '', owner: c[iOwner] || '', address: c[iAddr] || '', legal: c[iLegal] || '' };
    }).filter(r => r.id);
  }).catch(() => []);
}

async function readDetail(page) {
  return page.evaluate(() => {
    const text = (document.body.innerText || '').replace(/\r/g, '');
    const flat = text.replace(/\s+/g, ' ');
    const grab = re => ((flat.match(re) || [])[1] || '').trim();
    const tables = Array.from(document.querySelectorAll('table'));
    const rowsOf = t => Array.from(t.rows).map(r => Array.from(r.cells).map(c => (c.innerText || '').replace(/\s+/g, ' ').trim()));
    const startsWith = s => tables.find(t => (t.rows[0]?.innerText || '').trim().toLowerCase().startsWith(s));

    // Inner ownership table: rows = "Ownership" | owner | mailing lines | "Ownership Interest: …"
    const ownTbl = tables.find(t => (t.rows[0]?.innerText || '').trim().toLowerCase() === 'ownership');
    const own = ownTbl ? rowsOf(ownTbl).map(r => r.join(' ').trim()).filter(Boolean) : [];

    // "Values by Year" pivot: first row = years, then Improvements/Land/.../Total Market/Total Assessed
    const valTbl = startsWith('values by year');
    const valueHistory = [];
    if (valTbl) {
      const rows = rowsOf(valTbl);
      const years = (rows[0].join(' ').match(/\b\d{4}\b/g) || []);
      const rowFor = label => rows.find(r => r[0].toLowerCase().startsWith(label));
      const amt = (r, i) => (r ? (r.join(' ').match(/\$[\d,]+/g) || [])[i] || '' : '');
      years.forEach((y, i) => valueHistory.push({
        year: y,
        improvements: amt(rowFor('improvements'), i),
        land:         amt(rowFor('land'), i),
        marketValue:  amt(rowFor('total market'), i),
        assessed:     amt(rowFor('total assessed'), i),
      }));
    }

    // Estimated tax per taxing entity: Code | Description | Taxable | Rate/$100 | Factor | Estimated Tax
    const taxTbl = tables.find(t => /tax rate per \$100/i.test(t.rows[0]?.innerText || ''));
    const taxingUnits = taxTbl ? rowsOf(taxTbl).slice(1)
      .filter(r => r.length >= 6 && r[1])
      .map(r => ({ code: r[0], name: r[1], taxableValue: r[2], ratePer100: r[3], estimatedTax: r[5] })) : [];

    return {
      propertyId: grab(/Property ID:\s*(\S+)/),
      // Blank on many accounts — then the next label ("Property …") follows directly
      geoId:      grab(/Geo ID:\s*(\S*\d\S*)/),
      year:       grab(/Property Year\s+(\d{4})/),
      ownerName:  own[1] || '',
      mailing:    own.slice(2).filter(s => !/^Ownership Interest/i.test(s)).join(', '),
      legal:      grab(/Legal:\s*(.+?)\s+Situs:/),
      situs:      grab(/Situs:\s*(.+?)\s+Property Valuation History/),
      exemptions: grab(/Qualified Exemptions\s*(.+?)\s+Legal Information/),
      valueHistory,
      taxingUnits,
      estimatedTotalTax: grab(/Total Estimation\s+\S+\s+\S+\s+(\$[\d,.]+)/),
    };
  }).catch(() => ({}));
}

async function search(page, { accountNumber = '', firstName = '', lastName = '', fullName = '', onProgress = () => {} }) {
  const p = portal(page.url());
  if (!p) return null;

  const acct = (accountNumber || '').trim().toUpperCase();
  // Site hint: "Enter only the first part of the last name ... no spaces"
  const last = (lastName || (fullName || firstName).trim().split(/\s+/).pop() || '').replace(/[^A-Za-z'-]/g, '').toUpperCase();
  if (!acct && last.length < 2) return null;

  try {
    let rows;
    if (acct) {
      onProgress(`Southwest Data Solutions: opening property ${acct}...`);
      rows = [{ id: acct }];
    } else {
      onProgress(`Southwest Data Solutions: searching owner "${last}"...`);
      const url = `${p.origin}/webSearchName.aspx?dbkey=${p.dbkey}&stype=name&sdata=${encodeURIComponent(last)}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
      rows = await readResults(page);
      console.log(`[isw] ${p.dbkey} owner=${last} → ${rows.length} rows`);
      if (!rows.length) {
        return { records: [], totalFound: 0, searchedUrl: page.url(), summary: `No records found for owner "${last}".` };
      }
    }

    const records = [];
    for (const row of rows.slice(0, MAX_DETAILS)) {
      const detailUrl = `${p.origin}/webProperty.aspx?dbkey=${p.dbkey}&id=${encodeURIComponent(row.id)}`;
      onProgress(`Southwest Data Solutions: loading ${row.id}...`);
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      await page.waitForTimeout(1000);
      const d = await readDetail(page);
      if (!d.propertyId && acct) {
        return { records: [], totalFound: 0, searchedUrl: detailUrl, summary: `No property found for ID ${acct}.` };
      }
      const cur = d.valueHistory?.[0] || {};
      records.push({
        parcelId:         d.propertyId || row.id,
        ownerName:        d.ownerName || row.owner || '',
        propertyAddress:  d.situs || row.address || '',
        legalDescription: d.legal || row.legal || '',
        taxAmountDue:     d.estimatedTotalTax || '',
        taxYear:          d.year || cur.year || '',
        paymentStatus:    '',
        county:           '',
        state:            'TX',
        additionalDetails: JSON.stringify({
          geoId:             d.geoId || row.geoId || '',
          mailingAddress:    d.mailing || '',
          exemptions:        d.exemptions || '',
          marketValue:       cur.marketValue || '',
          appraisedValue:    cur.assessed || cur.marketValue || '',
          landMarketValue:   cur.land || '',
          improvementValue:  cur.improvements || '',
          legalDescription:  d.legal || row.legal || '',
          valueHistory:      d.valueHistory || [],
          taxingUnits:       d.taxingUnits || [],
          estimatedTotalTax: d.estimatedTotalTax || '',
          detailPageUrl:     detailUrl,
        }),
      });
    }

    return {
      records,
      totalFound: acct ? records.length : rows.length,
      summary: `Found ${acct ? records.length : rows.length} total, showing first ${records.length} record(s) for ${acct || last} (Southwest Data Solutions).`,
      searchedUrl: page.url(),
    };
  } catch (err) {
    console.log(`[isw] error: ${err.message}`);
    return null;
  }
}

module.exports = { search };
