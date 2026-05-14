'use strict';

/**
 * test-reporter.js
 *
 * Generates three output artefacts:
 *   1. reports/test-{state}-{timestamp}.html  — interactive dashboard
 *   2. reports/test-{state}-{timestamp}.json  — machine-readable results
 *   3. reports/test-{state}-{timestamp}.csv   — spreadsheet import
 */

const fs   = require('fs');
const path = require('path');

const REPORTS_DIR = path.resolve(__dirname, 'reports');

function ts() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    + `-${String(d.getHours()).padStart(2,'0')}-${String(d.getMinutes()).padStart(2,'0')}`;
}

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ─── Grade badge ──────────────────────────────────────────────────────────────
function gradeBadge(grade) {
  return `<span style="background:${esc(grade.color)};color:#fff;padding:3px 10px;border-radius:20px;font-weight:700;font-size:12px">${esc(grade.letter)}</span>`;
}

// ─── Per-county detail card (expanded row) ────────────────────────────────────
function buildDetailRows(allResults) {
  return allResults.map(({ parsed, check, classification }) => {
    const { fieldResults, groupSummary } = check;
    const grpHtml = Object.entries(groupSummary).map(([grpName, grp]) => {
      const rows = grp.fields.map(f => `
        <tr>
          <td style="padding:4px 8px;font-size:12px;color:#374151">${esc(f.label)}</td>
          <td style="padding:4px 8px;font-size:11px;color:#6b7280">${esc(f.tier)}</td>
          <td style="padding:4px 8px;text-align:center">${f.pass
            ? '<span style="color:#16a34a;font-weight:700">✓ PASS</span>'
            : '<span style="color:#dc2626;font-weight:700">✗ FAIL</span>'}</td>
          <td style="padding:4px 8px;font-size:11px;color:#4b5563">${esc(f.value || f.failMsg || '')}</td>
        </tr>`).join('');
      const allPass = grp.fail === 0;
      return `
        <tr style="background:#f8fafc">
          <td colspan="4" style="padding:6px 12px;font-size:12px;font-weight:600;color:${allPass?'#15803d':'#b45309'}">
            ${esc(grpName)} — ${grp.pass}/${grp.pass+grp.fail} fields
          </td>
        </tr>${rows}`;
    }).join('');

    const issueHtml = classification.issues.map(iss =>
      `<div style="margin:4px 0;padding:5px 10px;border-left:3px solid ${esc(iss.color)};background:${esc(iss.color)}18;font-size:12px">
         <strong>${esc(iss.label)}</strong>: ${esc(iss.detail || iss.description)}
       </div>`
    ).join('');

    const fixHtml = classification.fixes.map((f, i) =>
      `<div style="margin:3px 0;font-size:12px;color:#374151">
         <strong>${i+1}. ${esc(f.action)}:</strong> ${esc(f.detail)}
       </div>`
    ).join('');

    return `
    <tr class="detail-row" id="detail-${esc(parsed.county.replace(/\s+/g,'-'))}" style="display:none">
      <td colspan="9" style="padding:0;background:#f8fafc;border-bottom:2px solid #e2e8f0">
        <div style="padding:16px 20px;display:grid;grid-template-columns:1fr 1fr;gap:20px">
          <div>
            <h4 style="margin-bottom:10px;font-size:13px;color:#1e293b">Field-by-Field Results</h4>
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr style="background:#e2e8f0">
                <th style="padding:5px 8px;text-align:left">Field</th>
                <th style="padding:5px 8px;text-align:left">Tier</th>
                <th style="padding:5px 8px">Status</th>
                <th style="padding:5px 8px;text-align:left">Value / Reason</th>
              </tr></thead>
              <tbody>${grpHtml}</tbody>
            </table>
          </div>
          <div>
            <h4 style="margin-bottom:8px;font-size:13px;color:#1e293b">Issues Detected</h4>
            ${issueHtml || '<p style="color:#94a3b8;font-size:12px">No issues</p>'}
            <h4 style="margin:12px 0 8px;font-size:13px;color:#1e293b">Fix Roadmap</h4>
            ${fixHtml || '<p style="color:#94a3b8;font-size:12px">No fixes needed</p>'}
            <div style="margin-top:12px;font-size:11px;color:#94a3b8">
              Platform: <code>${esc(parsed.platform)}</code> |
              URL: <a href="${esc(parsed.url||'')}" target="_blank" style="color:#3b82f6">${esc((parsed.url||'').slice(0,50))}</a>
            </div>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ─── Main HTML builder ────────────────────────────────────────────────────────
function buildHtml(allResults, aggregate, issueAggregate, metadata) {
  const { grades, sourceDist, avgScore, totalCounties } = aggregate;

  // Summary row per county
  const tableRows = allResults.map(({ parsed, check, classification }) => {
    const g   = check.grade;
    const src = classification.dataSource || {};
    const srcLabel = src.both ? '🔵 CAD+Tax'
                   : src.cadOnly ? '🟠 CAD only'
                   : src.neither ? '⚫ None'
                   : '🟢 Tax+CAD';
    const issues = classification.issues.filter(i => i.id !== 'GOOD');
    const topIssue = issues[0];
    const countyId = parsed.county.replace(/\s+/g,'-');

    return `
      <tr onclick="toggleDetail('${countyId}')" style="cursor:pointer" data-grade="${g.letter}" data-platform="${esc(parsed.platform)}">
        <td style="padding:8px 12px;font-weight:600">${esc(parsed.county)}</td>
        <td style="padding:8px 12px"><code style="font-size:11px">${esc(parsed.platform)}</code></td>
        <td style="padding:8px 12px;text-align:center">${check.passCount}/${check.totalRules}</td>
        <td style="padding:8px 12px;text-align:center;font-weight:600">${check.scorePct}%</td>
        <td style="padding:8px 12px;text-align:center">${gradeBadge(g)}</td>
        <td style="padding:8px 12px;font-size:11px">${srcLabel}</td>
        <td style="padding:8px 12px;font-size:11px;color:#6b7280">${topIssue
          ? `<span style="color:${topIssue.color}">⚠ ${esc(topIssue.label)}</span>`
          : '<span style="color:#16a34a">✓ Clean</span>'}</td>
        <td style="padding:8px 12px;font-size:11px;color:#3b82f6">▶ Details</td>
      </tr>`;
  }).join('');

  // Roadmap
  const roadmapRows = issueAggregate.roadmap.slice(0, 15).map(r => `
    <tr>
      <td style="padding:8px 12px;font-weight:600">#${r.rank}</td>
      <td style="padding:8px 12px">${esc(r.action)}</td>
      <td style="padding:8px 12px;text-align:center;font-weight:700;color:#1e40af">${r.count}</td>
      <td style="padding:8px 12px;font-size:11px;color:#6b7280">${r.examples.join(', ')}${r.count > 3 ? ` +${r.count-3} more` : ''}</td>
    </tr>`).join('');

  // Issue distribution
  const issueRows = Object.entries(issueAggregate.issueCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([id, cnt]) => {
      const meta = Object.values(require('./field-rules').ISSUE_TYPES).find(t => t.id === id) || {};
      return `<tr>
        <td style="padding:6px 12px"><span style="color:${meta.color||'#333'}">${esc(meta.label||id)}</span></td>
        <td style="padding:6px 12px;text-align:center;font-weight:700">${cnt}</td>
        <td style="padding:6px 12px;font-size:11px;color:#6b7280">${esc(meta.fix||'')}</td>
      </tr>`;
    }).join('');

  const detailRows = buildDetailRows(allResults);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Report Testing Agent — ${esc(metadata.state)} Tax Reports</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;color:#1e293b}
  header{background:linear-gradient(135deg,#1e3a5f,#2563eb);color:#fff;padding:24px 32px}
  header h1{font-size:22px;font-weight:700}header p{margin-top:6px;opacity:.85;font-size:13px}
  .container{max-width:1500px;margin:0 auto;padding:24px 32px}
  .section{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);padding:20px 24px;margin-bottom:24px}
  h2{font-size:16px;font-weight:600;margin-bottom:14px;border-bottom:2px solid #e2e8f0;padding-bottom:8px}
  .kpi-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}
  .kpi{border-radius:10px;padding:14px 16px;text-align:center}
  .kpi .val{font-size:28px;font-weight:700}.kpi .lbl{font-size:11px;margin-top:3px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;opacity:.8}
  .source-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px}
  .src-box{background:#f8fafc;border-radius:8px;padding:12px 16px;text-align:center}
  .src-box .v{font-size:26px;font-weight:700;color:#1e40af}.src-box .l{font-size:11px;color:#64748b;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{background:#f1f5f9;padding:9px 12px;text-align:left;font-weight:600;font-size:11px;text-transform:uppercase;color:#475569;border-bottom:2px solid #e2e8f0;position:sticky;top:0}
  td{padding:8px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
  tr:hover>td{background:#f8fafc}
  .filter-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;align-items:center}
  .fbtn{padding:5px 12px;border:1px solid #cbd5e1;border-radius:20px;background:#fff;cursor:pointer;font-size:12px;font-weight:500}
  .fbtn:hover,.fbtn.active{background:#1e40af;color:#fff;border-color:#1e40af}
  #search-inp{padding:7px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;max-width:260px}
  code{background:#f1f5f9;padding:2px 5px;border-radius:4px;font-size:10px}
  a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
  .hidden{display:none!important}
</style>
</head>
<body>
<header>
  <h1>🔬 Report Testing Agent — ${esc(metadata.state)} Tax Search</h1>
  <p>Counties tested: <strong>${totalCounties}</strong> &nbsp;|&nbsp; Avg completeness: <strong>${avgScore}%</strong> &nbsp;|&nbsp; Generated: <strong>${esc(metadata.generatedAt)}</strong></p>
</header>

<div class="container">

<!-- KPI Summary -->
<div class="section">
  <h2>Report Quality Overview</h2>
  <div class="kpi-grid">
    <div class="kpi" style="background:#f0fdf4;border:1px solid #bbf7d0"><div class="val" style="color:#16a34a">${grades.A||0}</div><div class="lbl" style="color:#16a34a">Grade A (85%+)</div></div>
    <div class="kpi" style="background:#f0fdf4;border:1px solid #bbf7d0"><div class="val" style="color:#22c55e">${grades.B||0}</div><div class="lbl" style="color:#22c55e">Grade B (70%+)</div></div>
    <div class="kpi" style="background:#fffbeb;border:1px solid #fde68a"><div class="val" style="color:#d97706">${grades.C||0}</div><div class="lbl" style="color:#d97706">Grade C (55%+)</div></div>
    <div class="kpi" style="background:#fff7ed;border:1px solid #fed7aa"><div class="val" style="color:#ea580c">${grades.D||0}</div><div class="lbl" style="color:#ea580c">Grade D (&lt;55%)</div></div>
    <div class="kpi" style="background:#fef2f2;border:1px solid #fecaca"><div class="val" style="color:#dc2626">${grades.F||0}</div><div class="lbl" style="color:#dc2626">Grade F (critical)</div></div>
    <div class="kpi" style="background:#eff6ff;border:1px solid #bfdbfe"><div class="val" style="color:#1d4ed8">${avgScore}%</div><div class="lbl" style="color:#1d4ed8">Avg Score</div></div>
  </div>
  <h2 style="margin-top:20px">Data Source Distribution</h2>
  <div class="source-grid">
    <div class="src-box"><div class="v" style="color:#16a34a">${sourceDist.BOTH}</div><div class="l">🔵 CAD + Tax Office</div></div>
    <div class="src-box"><div class="v" style="color:#f97316">${sourceDist.CAD_ONLY}</div><div class="l">🟠 CAD Data Only</div></div>
    <div class="src-box"><div class="v" style="color:#6b7280">${sourceDist.NONE}</div><div class="l">⚫ No Data Retrieved</div></div>
    <div class="src-box"><div class="v" style="color:#8b5cf6">${sourceDist.TAX_ONLY}</div><div class="l">🟣 Tax Office Only</div></div>
  </div>
</div>

<!-- Fix Roadmap -->
<div class="section">
  <h2>Priority Fix Roadmap — Ordered by Impact</h2>
  <table><thead><tr><th>#</th><th>Action Required</th><th style="text-align:center">Counties Affected</th><th>Example Counties</th></tr></thead>
  <tbody>${roadmapRows}</tbody></table>
</div>

<!-- Issue Distribution -->
<div class="section">
  <h2>Issue Type Distribution</h2>
  <table><thead><tr><th>Issue</th><th style="text-align:center">Count</th><th>Recommended Fix</th></tr></thead>
  <tbody>${issueRows}</tbody></table>
</div>

<!-- County Results Table -->
<div class="section">
  <h2>County-by-County Test Results <small style="font-weight:400;color:#94a3b8">(click any row to expand field details)</small></h2>
  <div class="filter-row">
    <input type="text" id="search-inp" placeholder="Filter county…" oninput="applyFilters()">
    <button class="fbtn active" onclick="setGrade('all',this)">All (${totalCounties})</button>
    ${['A','B','C','D','F'].filter(g=>grades[g]>0).map(g=>`<button class="fbtn" onclick="setGrade('${g}',this)">${g} (${grades[g]})</button>`).join('')}
  </div>
  <div style="overflow-x:auto">
  <table id="main-table">
    <thead><tr><th>County</th><th>Platform</th><th>Fields</th><th>Score</th><th>Grade</th><th>Data Source</th><th>Top Issue</th><th></th></tr></thead>
    <tbody>
      ${tableRows}
      ${detailRows}
    </tbody>
  </table></div>
</div>

</div>
<script>
let currentGrade = 'all', currentSearch = '';
function setGrade(g, btn) {
  currentGrade = g;
  document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyFilters();
}
function applyFilters() {
  currentSearch = document.getElementById('search-inp').value.toLowerCase();
  document.querySelectorAll('#main-table tbody tr:not(.detail-row)').forEach(row => {
    const grade  = row.dataset.grade;
    const county = row.cells[0]?.textContent.toLowerCase() || '';
    const show   = (currentGrade === 'all' || grade === currentGrade)
                && (!currentSearch || county.includes(currentSearch));
    row.classList.toggle('hidden', !show);
    const id = row.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
    if (id) { const d = document.getElementById('detail-' + id); if (d) d.classList.add('hidden'); }
  });
}
function toggleDetail(id) {
  const el = document.getElementById('detail-' + id);
  if (el) el.style.display = el.style.display === 'none' ? 'table-row' : 'none';
}
</script>
</body></html>`;
}

// ─── CSV builder ───────────────────────────────────────────────────────────────
function buildCsv(allResults) {
  const hdr = ['County','State','Platform','AutoStatus','Score%','Grade','FieldsPass','FieldsTotal','CritFails','DataSource','TopIssue','URL'].join(',');
  const rows = allResults.map(({ parsed, check, classification }) => {
    const src = classification.dataSource || {};
    const srcLabel = src.both ? 'CAD+Tax' : src.cadOnly ? 'CAD_Only' : src.neither ? 'None' : 'Tax_Only';
    return [
      parsed.county, parsed.state, parsed.platform, parsed.autoStatus,
      check.scorePct, check.grade.letter, check.passCount, check.totalRules, check.criticalFails,
      srcLabel,
      classification.primaryIssue || 'GOOD',
      (parsed.url || '').replace(/,/g, ' '),
    ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
  });
  return [hdr, ...rows].join('\n');
}

// ─── Main generate function ────────────────────────────────────────────────────
function generateTestReport(allResults, aggregate, issueAggregate, metadata = {}) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  metadata.generatedAt = new Date().toISOString();

  const stamp = ts();
  const base  = path.join(REPORTS_DIR, `test-${metadata.state || 'TX'}-${stamp}`);

  fs.writeFileSync(base + '.html', buildHtml(allResults, aggregate, issueAggregate, metadata), 'utf8');
  fs.writeFileSync(base + '.json', JSON.stringify({ metadata, aggregate, issueAggregate, results: allResults.map(r => ({ county: r.parsed.county, state: r.parsed.state, platform: r.parsed.platform, score: r.check.scorePct, grade: r.check.grade.letter, primaryIssue: r.classification.primaryIssue, fixes: r.classification.fixes })) }, null, 2), 'utf8');
  fs.writeFileSync(base + '.csv',  buildCsv(allResults), 'utf8');

  console.log(`\n[test-reporter] Reports:`);
  console.log(`  HTML → ${base}.html`);
  console.log(`  JSON → ${base}.json`);
  console.log(`  CSV  → ${base}.csv`);

  return { htmlPath: base + '.html', jsonPath: base + '.json', csvPath: base + '.csv' };
}

module.exports = { generateTestReport };
