'use strict';

/**
 * report-generator.js
 *
 * Produces:
 *   1. reports/tx-YYYY-MM-DD-HH-MM.html  — rich interactive HTML report
 *   2. reports/tx-YYYY-MM-DD-HH-MM.json  — raw results JSON for further processing
 *   3. reports/tx-YYYY-MM-DD-HH-MM.csv   — CSV for spreadsheet review
 */

const fs   = require('fs');
const path = require('path');

const REPORTS_DIR = path.resolve(__dirname, 'reports');

const STATUS_META = {
  pass:            { label: 'PASS',           color: '#22c55e', bg: '#f0fdf4', emoji: '✅' },
  partial:         { label: 'PARTIAL',         color: '#f59e0b', bg: '#fffbeb', emoji: '🟡' },
  fail:            { label: 'FAIL',            color: '#ef4444', bg: '#fef2f2', emoji: '❌' },
  captcha:         { label: 'CAPTCHA',         color: '#8b5cf6', bg: '#f5f3ff', emoji: '🔒' },
  no_results:      { label: 'NO RESULTS',      color: '#f97316', bg: '#fff7ed', emoji: '⚠️' },
  no_url:          { label: 'NO URL',          color: '#6b7280', bg: '#f9fafb', emoji: '🔗' },
  no_property_id:  { label: 'NO PROP ID',      color: '#d97706', bg: '#fffbeb', emoji: '🆔' },
  error:           { label: 'ERROR',           color: '#dc2626', bg: '#fef2f2', emoji: '💥' },
  pending:         { label: 'PENDING',         color: '#9ca3af', bg: '#f9fafb', emoji: '⏳' },
};

function ts() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    + `-${String(d.getHours()).padStart(2,'0')}-${String(d.getMinutes()).padStart(2,'0')}`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtMs(ms) {
  if (!ms) return '—';
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms/1000).toFixed(1)}s`;
  return `${(ms/60000).toFixed(1)}m`;
}

// ─── HTML Report ──────────────────────────────────────────────────────────────

function buildHtml(allResults, fixReport, aggregation, metadata) {
  const { counts, byPlatform, avgScore, totalCounties } = aggregation;
  const timestamp = metadata.generatedAt || new Date().toISOString();

  const summaryCards = Object.entries(STATUS_META)
    .filter(([k]) => counts[k] != null && counts[k] > 0)
    .map(([k, m]) => `
      <div class="card" style="border-left: 4px solid ${m.color}; background:${m.bg}">
        <div class="card-count" style="color:${m.color}">${counts[k]}</div>
        <div class="card-label">${m.emoji} ${m.label}</div>
      </div>`)
    .join('');

  const platformRows = Object.entries(byPlatform)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([plat, s]) => `
      <tr>
        <td><code>${esc(plat)}</code></td>
        <td>${s.total}</td>
        <td style="color:#22c55e">${s.pass}</td>
        <td style="color:#f59e0b">${s.partial}</td>
        <td style="color:#ef4444">${s.fail}</td>
        <td style="color:#6b7280">${s.other}</td>
        <td>${s.total > 0 ? Math.round(((s.pass + s.partial * 0.5) / s.total) * 100) : 0}%</td>
      </tr>`)
    .join('');

  const tableRows = allResults
    .sort((a, b) => {
      const order = { pass: 0, partial: 1, no_results: 2, no_property_id: 3, fail: 4, captcha: 5, error: 6, no_url: 7, pending: 8 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.county.localeCompare(b.county);
    })
    .map(r => {
      const m     = STATUS_META[r.status] || STATUS_META.pending;
      const nsCnt = r.nameSearch?.recordCount ?? '—';
      const idCnt = r.idSearch?.recordCount ?? '—';
      const notes = [];
      if (r.nameUsed && r.nameUsed !== 'Smith') notes.push(`Name: ${r.nameUsed}`);
      if (r.propertyId) notes.push(`ID: ${esc(r.propertyId)}`);
      if (r.errors?.length) notes.push(`Err: ${esc(r.errors[0])}`);
      if (r.warnings?.length) notes.push(`⚠ ${esc(r.warnings[0])}`);
      return `
        <tr class="row-${r.status}" data-status="${r.status}" data-platform="${r.platform}">
          <td><strong>${esc(r.county)}</strong></td>
          <td><code>${esc(r.platform || 'unknown')}</code></td>
          <td style="font-size:11px;word-break:break-all;max-width:200px">
            ${r.url ? `<a href="${esc(r.url)}" target="_blank">${esc(r.url.replace(/https?:\/\//,'').slice(0,40))}${r.url.length>48?'…':''}</a>` : '<em>none</em>'}
          </td>
          <td style="text-align:center">${nsCnt}</td>
          <td style="text-align:center">${idCnt}</td>
          <td style="text-align:center">${r.score ?? '—'}</td>
          <td style="text-align:center"><span class="badge" style="background:${m.bg};color:${m.color};border:1px solid ${m.color}">${m.emoji} ${m.label}</span></td>
          <td style="font-size:11px;color:#6b7280">${fmtMs(r.durationMs)}</td>
          <td style="font-size:11px;color:#374151">${notes.join('<br>')}</td>
        </tr>`;
    })
    .join('');

  const fixRows = (fixReport?.fixLog || []).map(f => `
    <tr>
      <td>${esc(f.county)}</td>
      <td>${esc(f.type)}</td>
      <td style="font-size:11px">${esc(f.reason)}</td>
      <td style="font-size:11px">${f.type === 'platform_update'
        ? `${esc(f.oldPlatform)} → <strong>${esc(f.newPlatform)}</strong>`
        : `${esc(f.oldUrl || '')} → <strong>${esc(f.newUrl || '')}</strong>`}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Texas Tax Search — County Automation Report</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f8fafc; color:#1e293b; }
  header { background:linear-gradient(135deg,#1e40af,#3b82f6); color:#fff; padding:24px 32px; }
  header h1 { font-size:24px; font-weight:700; }
  header p  { margin-top:6px; opacity:.85; font-size:14px; }
  .container { max-width:1400px; margin:0 auto; padding:24px 32px; }
  .section   { background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,.1); padding:20px 24px; margin-bottom:24px; }
  h2 { font-size:17px; font-weight:600; margin-bottom:16px; color:#1e293b; border-bottom:2px solid #e2e8f0; padding-bottom:8px; }
  .cards { display:flex; flex-wrap:wrap; gap:16px; }
  .card { border-radius:10px; padding:16px 20px; min-width:130px; text-align:center; }
  .card-count { font-size:32px; font-weight:700; }
  .card-label { font-size:12px; font-weight:600; margin-top:4px; text-transform:uppercase; letter-spacing:.5px; }
  .stats-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-bottom:8px; }
  .stat-box { background:#f1f5f9; border-radius:8px; padding:14px 18px; }
  .stat-box .val { font-size:26px; font-weight:700; color:#1e40af; }
  .stat-box .lbl { font-size:12px; color:#64748b; margin-top:2px; }
  .filters { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px; }
  .filter-btn { padding:5px 12px; border:1px solid #cbd5e1; border-radius:20px; background:#fff; cursor:pointer; font-size:12px; font-weight:500; transition:all .15s; }
  .filter-btn:hover, .filter-btn.active { background:#1e40af; color:#fff; border-color:#1e40af; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { background:#f1f5f9; padding:9px 12px; text-align:left; font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.3px; color:#475569; border-bottom:2px solid #e2e8f0; position:sticky; top:0; }
  td { padding:8px 12px; border-bottom:1px solid #f1f5f9; vertical-align:middle; }
  tr:hover td { background:#f8fafc; }
  tr.hidden { display:none; }
  .badge { padding:3px 8px; border-radius:20px; font-size:11px; font-weight:600; white-space:nowrap; }
  code { background:#f1f5f9; padding:2px 6px; border-radius:4px; font-size:11px; }
  a { color:#2563eb; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .no-fixes { color:#94a3b8; font-style:italic; padding:12px 0; }
  #search-box { padding:7px 12px; border:1px solid #cbd5e1; border-radius:8px; width:100%; max-width:320px; font-size:13px; margin-bottom:12px; }
  @media (max-width:768px) { .stats-grid { grid-template-columns:repeat(2,1fr); } }
</style>
</head>
<body>
<header>
  <h1>🏛️ Texas Counties — Tax Search Automation Report</h1>
  <p>State: <strong>TX</strong> &nbsp;|&nbsp; Total counties: <strong>${totalCounties}</strong> &nbsp;|&nbsp; Avg score: <strong>${avgScore}/100</strong> &nbsp;|&nbsp; Generated: <strong>${esc(timestamp)}</strong></p>
</header>

<div class="container">

<!-- Summary Cards -->
<div class="section">
  <h2>Summary</h2>
  <div class="cards">${summaryCards}</div>
  <div class="stats-grid" style="margin-top:20px">
    <div class="stat-box">
      <div class="val">${counts.pass || 0}</div>
      <div class="lbl">Fully Passing (score ≥ 80)</div>
    </div>
    <div class="stat-box">
      <div class="val">${(counts.pass || 0) + (counts.partial || 0)}</div>
      <div class="lbl">Returning Data (pass + partial)</div>
    </div>
    <div class="stat-box">
      <div class="val">${avgScore}</div>
      <div class="lbl">Average Quality Score / 100</div>
    </div>
  </div>
</div>

<!-- Platform Breakdown -->
<div class="section">
  <h2>By Platform Handler</h2>
  <table>
    <thead><tr><th>Platform</th><th>Total</th><th>Pass</th><th>Partial</th><th>Fail</th><th>Other</th><th>Success%</th></tr></thead>
    <tbody>${platformRows}</tbody>
  </table>
</div>

<!-- County Results -->
<div class="section">
  <h2>County-by-County Results</h2>
  <input type="text" id="search-box" placeholder="Filter by county name..." oninput="filterTable()">
  <div class="filters">
    <button class="filter-btn active" onclick="setFilter('all',this)">All (${totalCounties})</button>
    ${Object.entries(STATUS_META)
      .filter(([k]) => counts[k] > 0)
      .map(([k, m]) => `<button class="filter-btn" onclick="setFilter('${k}',this)">${m.emoji} ${m.label} (${counts[k]})</button>`)
      .join('')}
  </div>
  <div style="overflow-x:auto">
  <table id="county-table">
    <thead><tr>
      <th>County</th><th>Platform</th><th>URL</th>
      <th style="text-align:center">Name Results</th>
      <th style="text-align:center">ID Results</th>
      <th style="text-align:center">Score</th>
      <th style="text-align:center">Status</th>
      <th style="text-align:center">Duration</th>
      <th>Notes</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</div>

<!-- Auto-Fixes Applied -->
<div class="section">
  <h2>Auto-Fixes Applied${fixReport?.dryRun ? ' <small style="color:#6b7280">(DRY RUN — no changes saved)</small>' : ''}</h2>
  ${fixReport?.totalFixes > 0
    ? `<table><thead><tr><th>County</th><th>Fix Type</th><th>Reason</th><th>Change</th></tr></thead><tbody>${fixRows}</tbody></table>`
    : `<p class="no-fixes">No automatic fixes were needed or applied.</p>`}
</div>

</div><!-- /container -->

<script>
let currentFilter = 'all';
let currentSearch = '';

function setFilter(status, btn) {
  currentFilter = status;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyFilters();
}

function filterTable() {
  currentSearch = document.getElementById('search-box').value.toLowerCase();
  applyFilters();
}

function applyFilters() {
  const rows = document.querySelectorAll('#county-table tbody tr');
  rows.forEach(row => {
    const statusMatch = currentFilter === 'all' || row.dataset.status === currentFilter;
    const nameMatch   = !currentSearch || row.cells[0].textContent.toLowerCase().includes(currentSearch);
    row.classList.toggle('hidden', !(statusMatch && nameMatch));
  });
}
</script>
</body>
</html>`;
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

function buildCsv(allResults) {
  const header = ['County','State','Platform','URL','Status','Score','NameResults','PropertyId','IdResults','DurationMs','Errors'].join(',');
  const rows = allResults.map(r => [
    r.county,
    r.state,
    r.platform || '',
    (r.url || '').replace(/,/g, ' '),
    r.status,
    r.score ?? '',
    r.nameSearch?.recordCount ?? '',
    r.propertyId || '',
    r.idSearch?.recordCount ?? '',
    r.durationMs ?? '',
    (r.errors || []).join('; ').replace(/,/g, ';'),
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  return [header, ...rows].join('\n');
}

// ─── Main generate function ───────────────────────────────────────────────────

function generateReport(allResults, fixReport, aggregation, metadata = {}) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const stamp    = ts();
  const baseName = `tx-${metadata.state || 'TX'}-${stamp}`;
  const htmlPath = path.join(REPORTS_DIR, `${baseName}.html`);
  const jsonPath = path.join(REPORTS_DIR, `${baseName}.json`);
  const csvPath  = path.join(REPORTS_DIR, `${baseName}.csv`);

  metadata.generatedAt = new Date().toISOString();

  fs.writeFileSync(htmlPath, buildHtml(allResults, fixReport, aggregation, metadata), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({ metadata, aggregation, fixReport, results: allResults }, null, 2), 'utf8');
  fs.writeFileSync(csvPath,  buildCsv(allResults), 'utf8');

  console.log(`\n[report] Generated:`);
  console.log(`  HTML → ${htmlPath}`);
  console.log(`  JSON → ${jsonPath}`);
  console.log(`  CSV  → ${csvPath}`);

  return { htmlPath, jsonPath, csvPath };
}

module.exports = { generateReport };
