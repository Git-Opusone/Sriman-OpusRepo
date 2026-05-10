'use strict';

/**
 * scripts/patchGapStates.js
 *
 * Two-pass gap-fill for states with < 98% URL coverage (excluding NE states
 * which are handled by patchNEStates.js):
 *
 *  Pass 1 — RECLASSIFY all states: re-run platform detection on every existing
 *            URL so that "generic" entries get corrected to tyler/bis/beacon/etc.
 *
 *  Pass 2 — NETRONLINE REFETCH for every null-URL entry in gap states:
 *            SD, MS, MO, KY, DC, HI, DE, AZ, UT, NM, ID, NV, ND, PA, NJ, MD
 *
 * Usage:
 *   node scripts/patchGapStates.js                # both passes
 *   node scripts/patchGapStates.js --reclassify-only
 */

require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const { detectFromUrl } = require('../src/platformDetector');

const DB_PATH    = path.join(__dirname, '../data/counties.json');
const BASE       = 'https://publicrecords.netronline.com';
const DELAY_MS   = 700;
const TIMEOUT_MS = 12000;

// States handled by patchNEStates.js — skip here
const NE_STATES = new Set(['MA', 'NH', 'CT', 'ME', 'RI', 'VT']);

// Gap states (< 98% URL coverage) to netronline-refetch
const GAP_STATES = ['SD', 'MS', 'MO', 'KY', 'DC', 'HI', 'DE', 'AZ', 'UT', 'NM', 'ID', 'NV', 'ND', 'PA', 'NJ', 'MD'];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*',
};

const RECLASSIFY_ONLY = process.argv.includes('--reclassify-only') || process.argv.includes('--no-network');

const PLATFORM_URL_PATTERNS = [
  'qpublic.net', 'schneidercorp.com', 'tylerhost.net', 'iasworld',
  'tylertech.com', 'patriotproperties.com', 'visionappraisal.com', 'vgsi.com',
  'bisconsultants.com', 'cadcentral.com',
];
const PROPERTY_URL_KEYWORDS = [
  'assessor', 'appraisal', 'cad.org', 'propertysearch', 'property-search',
  'propertytax', 'property-tax', 'taxoffice', 'tax-office', 'taxsearch',
  'treasurer', 'taxcollect', 'taxassessor', 'revenue',
];
const PROPERTY_CONTEXT_KEYWORDS = [
  'assessor', 'appraisal', 'tax commissioner', 'tax assessor',
  'property tax', 'tax office', 'treasurer', 'revenue',
];
const SKIP_TEXT = [
  'clerk','recorder','gis','mapping','aerial','register of deeds',
  'vital','sos.','secretary of state','ucc','corporation','historic',
  'school district',
];
const SKIP_HREF = [
  'netronline.com','historicaerials.com','datastore.',
  'map.netronline','ncleg.gov',
  'myfloridacounty.com','georgia.gov','az.gov','texas.gov','ca.gov',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadDb() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveDb(db) {
  db.lastUpdated = new Date().toISOString().split('T')[0];
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ── Pass 1: Reclassify all states ────────────────────────────────────────────

function reclassifyAll(db) {
  let total = 0;
  let fixed = 0;
  for (const [code, counties] of Object.entries(db.states)) {
    if (NE_STATES.has(code)) continue; // handled by patchNEStates.js
    for (const [name, entry] of Object.entries(counties)) {
      if (name === '_done' || !entry.url) continue;
      total++;
      const detected = detectFromUrl(entry.url);
      if (detected !== entry.platform && detected !== 'generic') {
        console.log(`  [reclassify] ${code}/${name}: ${entry.platform} → ${detected}`);
        entry.platform = detected;
        fixed++;
      }
    }
  }
  return { total, fixed };
}

// ── Pass 2: Netronline refetch ────────────────────────────────────────────────

function scoreUrl(href, text, context) {
  const h = href.toLowerCase();
  const t = text.toLowerCase();
  const c = (context || '').toLowerCase();
  let score = 0;
  if (PLATFORM_URL_PATTERNS.some(p => h.includes(p))) score += 100;
  if (PROPERTY_URL_KEYWORDS.some(p => h.includes(p)))  score += 50;
  if (PROPERTY_CONTEXT_KEYWORDS.some(k => t.includes(k) || c.includes(k))) score += 30;
  if (t.includes('go to data online') || t.includes('data online')) score += 10;
  return score;
}

function pickBestUrl(links) {
  const candidates = links.filter(({ text, href }) => {
    const t = text.toLowerCase();
    const h = href.toLowerCase();
    if (SKIP_HREF.some(s => h.includes(s))) return false;
    if (SKIP_TEXT.some(s => t.includes(s))) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  const scored = candidates
    .map(l => ({ ...l, score: scoreUrl(l.href, l.text, l.context || '') }))
    .sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].href : null;
}

async function fetchHtml(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT_MS, validateStatus: () => true });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return res.data;
}

async function refetchFromNetronline(netronlinePath) {
  if (!netronlinePath) return null;
  const html  = await fetchHtml(`${BASE}${netronlinePath}`);
  const $     = cheerio.load(html);
  const links = [];
  $('a[href^="http"]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    const text = $(el).text().trim();
    if (!href || !text) return;
    const $section = $(el).closest('div,section,li,tr');
    const context  = $section.find('h1,h2,h3,h4,h5,strong,b,th').first().text().trim()
                  || $section.text().trim().substring(0, 120);
    links.push({ href, text, context });
  });
  return pickBestUrl(links);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const db = loadDb();

  // Pass 1: Reclassify
  console.log('\n══ Pass 1: Reclassify all non-NE states ════════════════════════════════');
  const { total, fixed } = reclassifyAll(db);
  console.log(`  Checked ${total} entries, reclassified ${fixed}`);
  saveDb(db);
  console.log('  [saved]');

  if (RECLASSIFY_ONLY) {
    console.log('\nReclassify-only mode — done.\n');
    return;
  }

  // Pass 2: Netronline refetch for gap states
  console.log('\n══ Pass 2: Netronline refetch for gap states ════════════════════════════');

  for (const code of GAP_STATES) {
    const stateEntries = db.states[code];
    if (!stateEntries) { console.log(`  ${code}: not in DB`); continue; }

    const nulls = Object.entries(stateEntries).filter(([k, v]) => k !== '_done' && !v.url);
    if (nulls.length === 0) { console.log(`  ${code}: no gaps`); continue; }

    console.log(`\n  ${code}: ${nulls.length} entries to refetch`);
    let filled = 0;

    for (const [name, entry] of nulls) {
      process.stdout.write(`    ${name}...`);
      if (!entry.netronlinePath) {
        process.stdout.write(' (no netronline path)\n');
        continue;
      }
      try {
        const url = await refetchFromNetronline(entry.netronlinePath);
        if (url) {
          entry.url      = url;
          entry.platform = detectFromUrl(url);
          process.stdout.write(` ✓ [${entry.platform}] ${url.substring(0, 60)}\n`);
          filled++;
        } else {
          process.stdout.write(' (no URL found)\n');
        }
      } catch (err) {
        process.stdout.write(` ✗ ${err.message}\n`);
      }
      await sleep(DELAY_MS);
    }

    saveDb(db);
    console.log(`  [saved] ${code}: filled ${filled}/${nulls.length}`);
  }

  // Summary
  console.log('\n══ Summary ══════════════════════════════════════════════════════════════');
  for (const code of [...GAP_STATES]) {
    const entries = Object.entries(db.states[code] || {}).filter(([k]) => k !== '_done');
    const total   = entries.length;
    const hasUrl  = entries.filter(([, v]) => v.url).length;
    console.log(`  ${code}: ${hasUrl}/${total} (${Math.round(hasUrl/total*100)}%)`);
  }
  console.log('\n✅ Done\n');
}

main().catch(err => { console.error(err); process.exit(1); });
