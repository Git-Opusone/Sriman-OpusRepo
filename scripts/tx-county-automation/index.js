#!/usr/bin/env node
'use strict';

/**
 * Texas County Tax Search — Self-Testing Automation
 *
 * Usage:
 *   node scripts/tx-county-automation           # test all TX counties
 *   node scripts/tx-county-automation --state TX --concurrency 3
 *   node scripts/tx-county-automation --resume  # continue from checkpoint
 *   node scripts/tx-county-automation --dry-run # analyse only, no file writes
 *   node scripts/tx-county-automation --from "Andrews" --to "Dallas"
 *   node scripts/tx-county-automation --county "Travis"  # single county
 *   node scripts/tx-county-automation --fix-only  # re-run fixer on existing results
 *   node scripts/tx-county-automation --report-only  # regenerate report only
 *
 * Environment:
 *   SERVER_URL   (default: http://localhost:3000)
 *   CONCURRENCY  (default: 3)
 *   STATE        (default: TX)
 */

const path = require('path');
const fs   = require('fs');
const http = require('http');

const { testCounty }           = require('./county-tester');
const { aggregateResults }     = require('./result-validator');
const { runSelfFixer,
        identifyPlatformGroups } = require('./self-fixer');
const { generateReport }       = require('./report-generator');

// ─── CLI args parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
};
const hasFlag = (flag) => args.includes(flag);

const SERVER_URL    = process.env.SERVER_URL   || getArg('--server', 'http://localhost:3000');
const CONCURRENCY   = parseInt(process.env.CONCURRENCY || getArg('--concurrency', '2'), 10);
const STATE         = process.env.STATE        || getArg('--state', 'TX');
const RESUME        = hasFlag('--resume');
const DRY_RUN       = hasFlag('--dry-run');
const FIX_ONLY      = hasFlag('--fix-only');
const REPORT_ONLY   = hasFlag('--report-only');
const VERBOSE       = hasFlag('--verbose');
const SINGLE_COUNTY = getArg('--county', null);
const FROM_COUNTY   = getArg('--from', null);
const TO_COUNTY     = getArg('--to', null);

const CHECKPOINT_FILE = path.resolve(__dirname, `reports/checkpoint-${STATE}.json`);
const LOCK_FILE       = path.resolve(__dirname, `reports/lock-${STATE}.pid`);
const COUNTIES_JSON   = path.resolve(__dirname, '../../data/counties.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadCountiesJson() {
  return JSON.parse(fs.readFileSync(COUNTIES_JSON, 'utf8'));
}

function loadCheckpoint() {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    try { return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8')); } catch (_) {}
  }
  return {};
}

function saveCheckpoint(results) {
  const dir = path.dirname(CHECKPOINT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write: write to tmp then rename so concurrent readers never see a partial file
  const tmp = CHECKPOINT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(results, null, 2), 'utf8');
  fs.renameSync(tmp, CHECKPOINT_FILE);
}

function checkServer(serverUrl) {
  return new Promise((resolve) => {
    const url = `${serverUrl}/api/health`;
    const lib = url.startsWith('https') ? require('https') : http;
    const req = lib.get(url, { timeout: 5000 }, (res) => {
      req.destroy();
      resolve(res.statusCode < 500);
    });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(serverUrl, maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await checkServer(serverUrl)) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

// ─── Concurrency-limited queue ────────────────────────────────────────────────

async function runWithConcurrency(items, concurrency, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i    = index++;
      const item = items[i];
      results[i] = await fn(item, i, items.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function progressLine(done, total, county, status) {
  const pct   = Math.round((done / total) * 100);
  const bar   = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
  const icons = { pass: '✅', partial: '🟡', fail: '❌', captcha: '🔒', no_results: '⚠️', no_url: '🔗', error: '💥', pending: '⏳', no_property_id: '🆔' };
  const icon  = icons[status] || '⏳';
  process.stdout.write(`\r[${bar}] ${pct}% (${done}/${total}) ${icon} ${county.padEnd(20).slice(0,20)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    // Check if that PID is still alive
    try { process.kill(parseInt(pid), 0); } catch (_) {
      fs.unlinkSync(LOCK_FILE); // stale lock — remove it
      fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
      return;
    }
    console.error(`\n[lock] Another automation instance is already running (PID ${pid}).`);
    console.error('If that process is gone, delete: ' + LOCK_FILE);
    process.exit(1);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
  process.on('exit',   () => { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM',() => process.exit(0));
}

async function main() {
  acquireLock();
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Texas Tax Search — County Automation Runner                 ║`);
  console.log(`║  State: ${STATE.padEnd(5)} Concurrency: ${String(CONCURRENCY).padEnd(3)} Server: ${SERVER_URL.slice(0,27).padEnd(27)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ── Verify server is alive ─────────────────────────────────────────────────
  if (!REPORT_ONLY && !FIX_ONLY) {
    process.stdout.write('Checking server...');
    const alive = await waitForServer(SERVER_URL, 10000);
    if (!alive) {
      console.log(` ❌\n\nServer not reachable at ${SERVER_URL}`);
      console.log('Please start the server first:  node server.js\n');
      process.exit(1);
    }
    console.log(` ✅  Connected to ${SERVER_URL}\n`);
  }

  // ── Load counties ──────────────────────────────────────────────────────────
  const allCountiesData = loadCountiesJson();
  const stateCounties   = allCountiesData.states?.[STATE] || {};
  let countyNames = Object.keys(stateCounties).filter(n => n !== '_done');

  // Apply filters
  if (SINGLE_COUNTY) {
    countyNames = countyNames.filter(n => n.toLowerCase() === SINGLE_COUNTY.toLowerCase());
    if (!countyNames.length) { console.error(`County "${SINGLE_COUNTY}" not found in ${STATE}`); process.exit(1); }
  } else if (FROM_COUNTY || TO_COUNTY) {
    const sorted = countyNames.sort();
    const fi = FROM_COUNTY ? sorted.findIndex(n => n.toLowerCase() >= FROM_COUNTY.toLowerCase()) : 0;
    const ti = TO_COUNTY   ? sorted.findIndex(n => n.toLowerCase() >  TO_COUNTY.toLowerCase())   : sorted.length;
    countyNames = sorted.slice(fi, ti === -1 ? undefined : ti);
  }

  console.log(`Total ${STATE} counties: ${countyNames.length}\n`);

  // ── Load checkpoint ────────────────────────────────────────────────────────
  // Always load existing checkpoint when --county is used (single-county update should merge, not replace)
  const checkpoint = (RESUME || FIX_ONLY || REPORT_ONLY || SINGLE_COUNTY) ? loadCheckpoint() : {};
  const doneSet    = new Set(Object.keys(checkpoint));

  const remaining  = (FIX_ONLY || REPORT_ONLY)
    ? []
    : countyNames.filter(n => !doneSet.has(n));

  if (RESUME && doneSet.size > 0) {
    console.log(`Resuming — ${doneSet.size} already done, ${remaining.length} remaining.\n`);
  }

  // ── Run tests ──────────────────────────────────────────────────────────────
  // When a county filter is active, progress tracks only the filtered set
  const isFiltered = !!(SINGLE_COUNTY || FROM_COUNTY || TO_COUNTY);
  let completed = isFiltered ? 0 : doneSet.size;
  const total   = countyNames.length;

  if (remaining.length > 0 && !REPORT_ONLY) {
    console.log(`Testing ${remaining.length} counties (concurrency=${CONCURRENCY})...\n`);

    await runWithConcurrency(remaining, CONCURRENCY, async (county) => {
      const countyData = stateCounties[county];
      const result = await testCounty(SERVER_URL, STATE, county, countyData, { verbose: VERBOSE });
      checkpoint[county] = result;
      completed++;
      saveCheckpoint(checkpoint);
      progressLine(completed, total, county, result.status);
      return result;
    });

    console.log('\n'); // newline after progress bar
  }

  // Collect all results in county order
  const allResults = countyNames
    .map(n => checkpoint[n])
    .filter(Boolean);

  if (allResults.length === 0) {
    console.log('No results to process. Run without --fix-only / --report-only first.\n');
    process.exit(0);
  }

  // ── Self-fixer ─────────────────────────────────────────────────────────────
  let fixReport = null;
  if (!REPORT_ONLY) {
    console.log('\n── Running self-fixer ────────────────────────────────────────────');
    fixReport = await runSelfFixer(allResults, SERVER_URL, { dryRun: DRY_RUN, verbose: VERBOSE });
  }

  // ── Platform group analysis ────────────────────────────────────────────────
  const { handlerCandidates } = identifyPlatformGroups(allResults);
  if (handlerCandidates.length > 0) {
    console.log('\n── Handler candidates (2+ failing counties on same domain) ──────────');
    handlerCandidates.slice(0, 10).forEach(c => {
      console.log(`  ${c.domain} (${c.count} counties): ${c.counties.slice(0,4).join(', ')}${c.count > 4 ? '...' : ''}`);
    });
  }

  // ── Generate report ────────────────────────────────────────────────────────
  const aggregation = aggregateResults(allResults);

  console.log('\n── Results summary ──────────────────────────────────────────────────');
  console.log(`  Total:      ${aggregation.totalCounties}`);
  Object.entries(aggregation.counts)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k.padEnd(16)}: ${v}`));
  console.log(`  Avg score:  ${aggregation.avgScore}/100`);

  const paths = generateReport(allResults, fixReport, aggregation, {
    state: STATE,
    serverUrl: SERVER_URL,
    handlerCandidates,
    testedAt: new Date().toISOString(),
  });

  console.log('\n✅  Done!');
  if (paths.htmlPath) {
    console.log(`\nOpen the report:\n  ${paths.htmlPath}\n`);
  }
}

main().catch((err) => {
  console.error('\n[fatal]', err.message);
  process.exit(1);
});
