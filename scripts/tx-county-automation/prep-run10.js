'use strict';
/**
 * prep-run10.js
 * Prepares for run10 by:
 *   1. Backing up the current checkpoint as checkpoint-TX-run9.json
 *   2. Creating a filtered checkpoint keeping only pass/partial/captcha entries
 *      (removes no_results/error/fail so run10 will re-test them with updated URLs)
 */
const fs   = require('fs');
const path = require('path');

const REPORTS_DIR    = path.resolve(__dirname, 'reports');
const CHECKPOINT     = path.join(REPORTS_DIR, 'checkpoint-TX.json');
const RUN9_BACKUP    = path.join(REPORTS_DIR, 'checkpoint-TX-run9.json');
const KEEP_STATUSES  = new Set(['pass', 'partial', 'captcha']);  // keep these, re-test the rest

if (!fs.existsSync(CHECKPOINT)) {
  console.error('No checkpoint found at', CHECKPOINT);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'));

// Backup
fs.writeFileSync(RUN9_BACKUP, JSON.stringify(data, null, 2), 'utf8');
console.log('Backed up run9 checkpoint to', RUN9_BACKUP);

// Build filtered checkpoint
const filtered = {};
const stats = { kept: 0, removed: 0, byStatus: {} };

for (const [county, entry] of Object.entries(data)) {
  const s = entry.status;
  stats.byStatus[s] = (stats.byStatus[s] || 0) + 1;
  if (KEEP_STATUSES.has(s)) {
    filtered[county] = entry;
    stats.kept++;
  } else {
    stats.removed++;
    console.log(`  [remove] ${county}: ${s}`);
  }
}

// Write filtered checkpoint
const tmp = CHECKPOINT + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(filtered, null, 2), 'utf8');
fs.renameSync(tmp, CHECKPOINT);

console.log(`\nDone. Kept ${stats.kept}, removed ${stats.removed} entries for re-test.`);
console.log('Status breakdown:', JSON.stringify(stats.byStatus));
console.log('\nRun10 will re-test:', stats.removed, 'counties with updated BIS esearch URLs.');
console.log('Start with: node scripts/tx-county-automation --resume --state TX --concurrency 3');
