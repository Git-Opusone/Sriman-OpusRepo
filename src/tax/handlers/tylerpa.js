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
  // so wait for real rows (Kendo grid, or a plain results table on some CADs);
  // an empty search simply times out to [].
  // Wait for a row whose first cell is a property ID (the placeholder row has none)
  await page.waitForFunction(() => Array.from(document.querySelectorAll('table tr')).some(tr => {
    const td = tr.querySelectorAll('td');
    return td.length >= 3 && /^[A-Z0-9-]{3,}$/i.test((td[0].textContent || '').trim()) && /\d/.test(td[0].textContent);
  }), null, { timeout: 30000 }).catch(() => {});
  return page.evaluate(() => {
    const txt = td => (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim();
    // Kendo renders an empty header grid first; the data grid is the one with rows
    // (older Kendo builds, e.g. Jackson CAD: table[role=grid] without .k-grid-table)
    const grid = Array.from(document.querySelectorAll('.k-grid-table, table[role="grid"]'))
      .filter(t => t.querySelector('tr td')).sort((a, b) => b.rows.length - a.rows.length)[0];
    if (grid) {
      // Row cells include hidden columns: ID | Account | Owner ID | Owner | Mailing | Situs |
      // Legal | Map | … | Type | Assessed | Market
      return Array.from(grid.rows).map(r => {
        const c = Array.from(r.cells).map(txt);
        return { id: c[0] || '', account: c[1] || '', owner: c[3] || '', mailing: c[4] || '', situs: c[5] || '',
                 legal: c[6] || '', type: c[10] || '', value: c[12] || c[11] || '' };
      }).filter(r => /^[A-Z0-9-]{3,}$/i.test(r.id));
    }
    // Plain table: PROPERTY ID | ACCOUNT | OWNER NAME | SITUS ADDRESS | <year> VALUE
    for (const tb of document.querySelectorAll('table')) {
      const hdr = Array.from(tb.querySelectorAll('th')).map(txt);
      const col = re => hdr.findIndex(h => re.test(h));
      const iId = col(/property id/i), iOwner = col(/owner name/i);
      if (iId < 0 || iOwner < 0) continue;
      const iAcct = col(/^account/i), iSitus = col(/situs|address/i), iVal = col(/value/i), iLegal = col(/legal/i);
      const rows = Array.from(tb.querySelectorAll('tr')).map(r => Array.from(r.querySelectorAll('td')).map(txt))
        .filter(c => c.length > iOwner);
      if (!rows.length) continue;
      return rows
        .map(c => ({ id: c[iId] || '', account: iAcct >= 0 ? c[iAcct] : '', owner: c[iOwner] || '', mailing: '',
                     situs: iSitus >= 0 ? c[iSitus] : '', legal: iLegal >= 0 ? c[iLegal] : '', type: '',
                     value: iVal >= 0 ? c[iVal] : '' }))
        .filter(r => /^[A-Z0-9-]{3,}$/i.test(r.id));
    }
    return [];
  }).catch(() => []);
}

async function readDetail(page) {
  return page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ');
    const grab = re => ((t.match(re) || [])[1] || '').trim();
    // Cells carry hidden mobile labels ("EXEMPTIONS: HS") — drop them
    const cell = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().replace(/^[A-Z][A-Z /&#]*:\s*/, '');
    // Header-matched tables: [headers, ...rows] — the shape the report renders
    const table = (re) => {
      for (const tb of Array.from(document.querySelectorAll('table')).filter(x => !x.querySelector('table'))) {
        const hdr = Array.from(tb.querySelectorAll('th')).map(cell);
        if (!hdr.some(h => re.test(h))) continue;
        const rows = Array.from(tb.querySelectorAll('tr')).map(r => Array.from(r.querySelectorAll('td')).map(cell))
          .filter(r => r.length >= 3 && r[0]);
        if (rows.length) return [hdr.slice(0, rows[0].length), ...rows];
      }
      return null;
    };
    const entities = grab(/TAX RATE PER 100\s+(.+?)\s+\d{4} IMPROVEMENTS/);
    return {
      year:          grab(/(\d{4}) GENERAL INFORMATION/),
      propertyType:  grab(/Property Type\s+(.+?)\s+Legal Description/),
      legal:         grab(/Legal Description\s+(.+?)\s+Neighborhood/),
      account:       grab(/Account\s+(\S+)/),
      ownerName:     grab(/Owner Name\s+(.+?)\s+Owner ID/),
      mailing:       grab(/Mailing Address\s+(.+?)\s+Agent/),
      exemptions:    grab(/Exemptions\s+(.+?)\s+Percent Ownership/),
      marketValue:   grab(/Total Market Value\s+(\$[\d,]+)/),
      landValue:     grab(/Total Land Market Value\s+(\$[\d,]+)/),
      imprValue:     grab(/Total Improvement Market Value\s+(\$[\d,]+)/),
      appraised:     grab(/Total Appraised Value\s+(\$[\d,]+)/),
      assessed:      grab(/Total Assessed Value\s+(\$[\d,]+)/),
      acres:         grab(/TOTALS\s+[\d,]+ Sq\. ft \/ ([\d.]+) acres/),
      entityTable:   table(/TAXING ENTITY/i),
      valueHistory:  table(/HS CAP LOSS|^IMPROVEMENT$/i),
      // "CAD- Williamson CAD N/A N/A N/A GWI- Williamson CO …" → entity names
      taxingUnits:   (entities.match(/[A-Z0-9]{2,4}- .+?(?= N\/A| \$| [\d,]+ |$)/g) || []).map(s => s.trim()),
    };
  }).catch(() => ({}));
}

// Before certification the newest year shows N/A everywhere; switch the page's
// tax-year menu (an ASP.NET postback) to the latest year that has values
async function readCertifiedDetail(page, onProgress) {
  let d = await readDetail(page);
  if (d.marketValue || !d.year) return d;
  const years = await page.$$eval('select.TaxYearsDropDown option', os => os.map(o => o.value)).catch(() => []);
  for (const y of years.filter(y => Number(y) < Number(d.year)).slice(0, 2)) {
    onProgress(`Tyler PublicAccess: ${d.year} values not certified yet — loading ${y}...`);
    await page.selectOption('select.TaxYearsDropDown', y).catch(() => {});
    const ok = await page.waitForFunction(yr => document.body.innerText.includes(`${yr} GENERAL INFORMATION`), y, { timeout: 30000 })
      .then(() => true).catch(() => false);
    if (!ok) break;
    await page.waitForTimeout(500);
    const prev = await readDetail(page);
    if (prev.marketValue) return { ...prev, valueHistory: d.valueHistory || prev.valueHistory, uncertifiedYear: d.year };
  }
  return d;
}

// Entity table → [Name, Exemptions, Exemption Amount, Taxable Value, Rate per 100, Estimated Tax]
function entityRows(tbl) {
  if (!tbl) return null;
  const num = s => parseFloat(String(s || '').replace(/[^0-9.]/g, '')) || 0;
  const rows = tbl.slice(1).filter(r => !/^totals?$/i.test(r[0])).map(r => {
    const [name, ex = '', exAmt = '', taxable = '', rate = ''] = r.map(c => (c === '-' ? '' : c));
    const est = num(taxable) && num(rate) ? '$' + (num(taxable) * num(rate) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
    return [name, ex, exAmt, /n\/a/i.test(taxable) ? '' : taxable, /n\/a/i.test(rate) ? '' : rate, est];
  });
  return rows.length ? [['Name', 'Exemptions', 'Exemption Amount', 'Taxable Value', 'Rate per 100', 'Estimated Tax'], ...rows] : null;
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
      // A bot-check interstitial is "blocked", not "no records" (detection only — never solved)
      const challenged = await page.evaluate(() => /just a moment|attention required|verify you are human/i
        .test(document.title + ' ' + (document.body ? document.body.innerText.slice(0, 500) : ''))).catch(() => false);
      if (challenged) {
        return { records: [], totalFound: 0, captchaBlocked: true, captchaType: 'Cloudflare challenge', searchedUrl: searchUrl,
          summary: 'Search blocked by Cloudflare challenge on this county website. This order could not be completed automatically and requires manual resolution.' };
      }
      return { records: [], totalFound: 0, searchedUrl: searchUrl, summary: `No properties found for "${q}".` };
    }

    const records = [];
    let detailsBlocked = false;
    for (const row of rows.slice(0, MAX_DETAILS)) {
      const detailUrl = `${origin}/Property-Detail/PropertyQuickRefID/${encodeURIComponent(row.id)}`;
      onProgress(`Tyler PublicAccess: loading ${row.id}...`);
      // Detail pages render client-side and can take a while on busy CADs; one retry.
      // Some CADs put a bot check on detail pages only — then keep the grid data.
      let d = {};
      if (!detailsBlocked) {
        for (let attempt = 0; attempt < 2; attempt++) {
          await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          const state = await page.waitForFunction(() => {
            const t = document.body ? document.body.innerText : '';
            return /\d{4} GENERAL INFORMATION/.test(t) ? 'ok' : /Just a moment|Attention Required|Verify you are human/i.test(t) && performance.now() > 15000 ? 'blocked' : false;
          }, null, { timeout: 30000, polling: 1000 }).then(h => h.jsonValue()).catch(() => 'timeout');
          if (state === 'ok') { d = await readCertifiedDetail(page, onProgress); break; }
          if (state === 'blocked') {
            detailsBlocked = true;
            console.log(`[tylerpa] ${origin} detail pages behind a bot check — using search-grid data`);
            onProgress('Tyler PublicAccess: detail pages are behind a bot check — showing search results only');
            break;
          }
        }
      }
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
          assessedValue:    d.assessed || '',
          netAppraisedValue: d.assessed || d.appraised || '',
          landMarketValue:  d.landValue || '',
          improvementValue: d.imprValue || '',
          legalDescription: d.legal || row.legal,
          legalAcreage:     d.acres ? String(Number(d.acres)) : '',
          exemptions:       d.exemptions || '',
          taxingUnits:      entityRows(d.entityTable) || (d.taxingUnits || []).map(n => [n]).reduce((a, r) => (a.push(r), a), [['Name']]),
          valueHistory:     d.valueHistory || null,
          ...(d.uncertifiedYear ? { note: `${d.uncertifiedYear} values are not certified yet; showing ${d.year}.` } : {}),
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
