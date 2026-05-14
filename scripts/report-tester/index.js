#!/usr/bin/env node
'use strict';

/**
 * Report Testing Agent
 *
 * Tests the quality of generated tax reports against the Anderson County
 * gold-standard checklist and produces an interactive HTML report.
 *
 * Usage:
 *   node scripts/report-tester                        # test all TX counties in checkpoint
 *   node scripts/report-tester --state TX             # explicit state
 *   node scripts/report-tester --county Andrews       # single county deep-dive
 *   node scripts/report-tester --county Andrews --state TX
 *   node scripts/report-tester --file path/to/results.json  # test from results file
 *   node scripts/report-tester --summary              # console summary only (no HTML)
 */

const path = require('path');

const { loadCheckpoint, loadResultsJson, loadSingleCounty } = require('./report-parser');
const { checkCounty, checkAll }       = require('./field-checker');
const { classifyIssues, aggregateIssues } = require('./issue-classifier');
const { generateTestReport }          = require('./test-reporter');
const { TIER }                        = require('./field-rules');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const getArg     = (f, d) => { const i = args.indexOf(f); return i !== -1 && args[i+1] ? args[i+1] : d; };
const hasFlag    = f => args.includes(f);

const STATE      = getArg('--state',  'TX');
const COUNTY     = getArg('--county', null);
const FILE       = getArg('--file',   null);
const SUMMARY    = hasFlag('--summary');

// ─── Grade legend ─────────────────────────────────────────────────────────────
const GRADE_ICONS = { A: '✅', B: '🟢', C: '🟡', D: '🟠', F: '❌' };

// ─── Load county data ─────────────────────────────────────────────────────────
function loadParsed() {
  if (FILE) {
    console.log(`Loading from file: ${FILE}`);
    return loadResultsJson(FILE);
  }
  if (COUNTY) {
    console.log(`Loading single county: ${COUNTY} / ${STATE}`);
    return loadSingleCounty(COUNTY, STATE);
  }
  console.log(`Loading all ${STATE} counties from checkpoint...`);
  return loadCheckpoint(STATE);
}

// ─── Console summary ──────────────────────────────────────────────────────────
function printSummary(allResults, aggregate, issueAggregate) {
  const { grades, sourceDist, avgScore, totalCounties } = aggregate;

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log(`║  Report Testing Agent — ${STATE} Tax Reports`.padEnd(61) + '║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  console.log(`Total counties tested: ${totalCounties}`);
  console.log(`Average completeness:  ${avgScore}%\n`);

  console.log('Grade Distribution:');
  ['A','B','C','D','F'].forEach(g => {
    if (grades[g]) console.log(`  ${GRADE_ICONS[g]} Grade ${g}: ${grades[g]} counties`);
  });

  console.log('\nData Source Distribution:');
  console.log(`  🔵 CAD + Tax Office : ${sourceDist.BOTH}`);
  console.log(`  🟠 CAD Data Only    : ${sourceDist.CAD_ONLY}`);
  console.log(`  ⚫ No Data          : ${sourceDist.NONE}`);

  console.log('\nTop Fix Actions (by impact):');
  issueAggregate.roadmap.slice(0, 8).forEach(r => {
    console.log(`  ${r.rank}. [${r.count} counties] ${r.action} — e.g. ${r.examples.slice(0,2).join(', ')}`);
  });

  if (COUNTY) {
    // Deep-dive for single county
    const r = allResults[0];
    if (!r) return;
    const { parsed, check, classification } = r;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`County: ${parsed.county}, ${parsed.state}  |  Platform: ${parsed.platform}`);
    console.log(`Score: ${check.scorePct}%  |  Grade: ${check.grade.letter} (${check.grade.label})`);
    console.log(`Fields: ${check.passCount}/${check.totalRules} passed`);

    console.log('\nField Results:');
    Object.entries(check.groupSummary).forEach(([grp, g]) => {
      console.log(`  ${grp}:`);
      g.fields.forEach(f => {
        const icon = f.pass ? '✓' : (f.tier === TIER.CRITICAL ? '✗' : '○');
        const val  = f.pass ? ` = ${f.value}` : ` → ${f.failMsg}`;
        console.log(`    ${icon} [${f.tier.slice(0,4)}] ${f.label}${val}`);
      });
    });

    console.log('\nIssues:');
    classification.issues.forEach(i => console.log(`  • ${i.label}: ${i.detail || i.description}`));

    console.log('\nFix Roadmap:');
    classification.fixes.forEach((f, i) => console.log(`  ${i+1}. ${f.action}: ${f.detail}`));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  let parsedList;
  try {
    parsedList = loadParsed();
  } catch (err) {
    console.error('\n[error]', err.message);
    process.exit(1);
  }

  if (parsedList.length === 0) {
    console.log('No county data found to test.');
    process.exit(0);
  }

  console.log(`\nRunning field checks on ${parsedList.length} counties...`);

  // Run all checks
  const aggregate    = checkAll(parsedList);
  const allResults   = aggregate.results.map(({ parsed, check }) => ({
    parsed,
    check,
    classification: classifyIssues(parsed, check),
  }));

  const issueAggregate = aggregateIssues(allResults);

  // Always print summary to console
  printSummary(allResults, aggregate, issueAggregate);

  // Generate HTML/JSON/CSV report unless --summary only
  if (!SUMMARY) {
    const paths = generateTestReport(
      allResults,
      aggregate,
      issueAggregate,
      { state: STATE, county: COUNTY || 'ALL', testedAt: new Date().toISOString() }
    );
    console.log(`\n✅  Open the report:\n  ${paths.htmlPath}\n`);
  }
}

main().catch(err => { console.error('\n[fatal]', err.message); process.exit(1); });
