'use strict';

/**
 * scripts/patchNEStates.js
 *
 * Targeted audit + fill for the six New England states:
 *   MA, NH, CT, ME, RI, VT
 *
 * Three passes in order:
 *
 *  1. RECLASSIFY — re-run platform detection on every existing URL in these states.
 *     Many entries were saved as "generic" before the patriot/vision handlers existed;
 *     this corrects them without any network requests.
 *
 *  2. VT PATTERN PROBE — for Vermont null entries, generate and HEAD-check the two
 *     dominant NE platforms before hitting netronline:
 *       • Vision Gov Solutions  → https://gis.vgsi.com/{Town}VT/
 *       • Patriot Properties    → https://www.patriotproperties.com/{TOWN}/default.asp
 *
 *  3. NETRONLINE REFETCH — for every remaining null entry across all six states,
 *     refetch the county page on publicrecords.netronline.com.
 *     Uses the same scoring logic as buildCountyDirectory.js.
 *
 * Usage:
 *   node scripts/patchNEStates.js            # all three passes
 *   node scripts/patchNEStates.js --reclassify-only
 *   node scripts/patchNEStates.js --no-network  (same as --reclassify-only)
 */

require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const { detectFromUrl } = require('../src/shared/platformDetector');

// ─── Config ───────────────────────────────────────────────────────────────────

const DB_PATH    = path.join(__dirname, '../data/counties.json');
const BASE       = 'https://publicrecords.netronline.com';
const DELAY_MS   = 700;
const TIMEOUT_MS = 12000;
const TARGET_STATES = ['MA', 'NH', 'CT', 'ME', 'RI', 'VT'];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*',
};

const ARGS             = process.argv.slice(2);
const RECLASSIFY_ONLY  = ARGS.includes('--reclassify-only') || ARGS.includes('--no-network');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadDb() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`counties.json not found at ${DB_PATH}`);
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveDb(db) {
  db.lastUpdated = new Date().toISOString().split('T')[0];
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ─── Pass 1: Reclassify ───────────────────────────────────────────────────────

function reclassifyState(db, stateCode) {
  const entries = db.states[stateCode];
  if (!entries) return { fixed: 0, total: 0 };

  let fixed = 0;
  let total = 0;

  for (const [name, entry] of Object.entries(entries)) {
    if (name === '_done' || !entry.url) continue;
    total++;
    const detected = detectFromUrl(entry.url);
    if (detected !== entry.platform && detected !== 'generic') {
      console.log(`  [reclassify] ${stateCode}/${name}: ${entry.platform} → ${detected}  (${entry.url.substring(0, 60)})`);
      entry.platform = detected;
      fixed++;
    }
  }
  return { fixed, total };
}

// ─── Pass 2: VT Pattern Probe ─────────────────────────────────────────────────

/**
 * Normalise a town name to the CamelCase format used by Vision/Patriot URLs.
 * e.g. "Saint Johnsbury" → "SaintJohnsbury"
 *      "Barre City"      → "BarreCity"
 *      "Isle La Motte"   → "IsleLaMotte"
 */
function normaliseTownName(name) {
  return name
    .replace(/[()]/g, '')          // remove parens, e.g. "Manchester (Town of)"
    .replace(/\bof\b/gi, '')       // drop "of"
    .replace(/[^a-zA-Z\s]/g, '')   // strip punctuation
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

/**
 * Check whether a URL resolves to a real Patriot Properties portal.
 * patriotproperties.com uses wildcard DNS — any subdomain returns 200.
 * Real portals STAY at *.patriotproperties.com after redirects.
 * Fake ones redirect to catalisgov.com/patriot-lp/.
 */
async function patriotPortalCheck(url) {
  try {
    const res = await axios.get(url, {
      headers: HEADERS,
      timeout: TIMEOUT_MS,
      maxRedirects: 10,
      validateStatus: () => true,
    });
    const finalUrl = res.request?.res?.responseUrl || res.config?.url || url;
    return finalUrl.includes('patriotproperties.com');
  } catch (_) {
    return false;
  }
}

/**
 * Check whether a Vision/vgsi URL returns a real assessment page.
 * gis.vgsi.com has real per-town paths; a 404/redirect indicates no portal.
 */
async function visionPortalCheck(url) {
  try {
    const res = await axios.get(url, {
      headers: HEADERS,
      timeout: TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (res.status >= 400) return false;
    // Must mention vgsi or visionappraisal in the response body
    const body = typeof res.data === 'string' ? res.data.toLowerCase() : '';
    return body.includes('vgsi') || body.includes('visionappraisal') || body.includes('vision government');
  } catch (_) {
    return false;
  }
}

async function probePatterns(townName, stateCode) {
  const norm  = normaliseTownName(townName);
  const lower = norm.toLowerCase();
  const sc    = stateCode.toLowerCase();
  const SC    = stateCode.toUpperCase();

  // Vision: gis.vgsi.com/{Town}{ST}/  (CamelCase town + uppercase state)
  const visionUrl = `https://gis.vgsi.com/${norm}${SC}/`;
  if (await visionPortalCheck(visionUrl)) {
    console.log(`  [probe] ${stateCode}/${townName} → ${visionUrl}`);
    return { url: visionUrl, platform: 'vision' };
  }
  await sleep(150);

  // Patriot subdomain: {town}{state}.patriotproperties.com/  (all lowercase)
  const patriotWithState = `https://${lower}${sc}.patriotproperties.com/`;
  if (await patriotPortalCheck(patriotWithState)) {
    console.log(`  [probe] ${stateCode}/${townName} → ${patriotWithState}`);
    return { url: patriotWithState, platform: 'patriot' };
  }
  await sleep(150);

  // Patriot subdomain without state suffix (common for MA towns)
  const patriotNoState = `https://${lower}.patriotproperties.com/`;
  if (await patriotPortalCheck(patriotNoState)) {
    console.log(`  [probe] ${stateCode}/${townName} → ${patriotNoState}`);
    return { url: patriotNoState, platform: 'patriot' };
  }
  await sleep(150);

  return null;
}

// ─── Pass 3: Netronline Refetch ───────────────────────────────────────────────

// Scoring helpers (mirrors buildCountyDirectory.js)

const PLATFORM_URL_PATTERNS = [
  'qpublic.net', 'schneidercorp.com', 'tylerhost.net', 'iasworld',
  'tylertech.com', 'patriotproperties.com', 'visionappraisal.com', 'vgsi.com',
  'bisconsultants.com', 'cadcentral.com',
];
const PROPERTY_URL_KEYWORDS = [
  'assessor', 'appraisal', 'cad.org', 'propertysearch', 'property-search',
  'propertytax', 'property-tax', 'taxoffice', 'tax-office', 'taxsearch',
  'treasurer', 'taxcollect', 'taxassessor', 'revenue', 'grandlist', 'grand-list',
  'listvt',
];
const PROPERTY_CONTEXT_KEYWORDS = [
  'assessor', 'appraisal', 'tax commissioner', 'tax assessor',
  'property tax', 'tax office', 'treasurer', 'revenue', 'grand list', 'lister',
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
    const $el      = $(el);
    const $section = $el.closest('div,section,li,tr');
    const context  = $section.find('h1,h2,h3,h4,h5,strong,b,th').first().text().trim()
                  || $section.text().trim().substring(0, 120);
    links.push({ href, text, context });
  });

  return pickBestUrl(links);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = loadDb();

  // ── Pass 0: Clear false-positive URLs from previous incorrect probe run ──────
  // The previous probe used www.patriotproperties.com/{TOWN}/default.asp which is
  // the corporate WordPress site, not a real search portal. Clear those entries.
  console.log('\n══ Pass 0: Clearing false-positive corporate URLs ══════════════════');
  const FAKE_PATTERN = /^https?:\/\/www\.patriotproperties\.com\/[A-Z]+\/default\.asp$/i;
  let cleared = 0;
  for (const code of TARGET_STATES) {
    for (const [name, entry] of Object.entries(db.states[code] || {})) {
      if (name === '_done' || !entry.url) continue;
      if (FAKE_PATTERN.test(entry.url)) {
        console.log(`  [clear] ${code}/${name}: ${entry.url}`);
        entry.url      = null;
        entry.platform = 'unknown';
        cleared++;
      }
    }
  }
  console.log(`  Cleared ${cleared} false-positive entries`);
  saveDb(db);
  console.log('  [saved]');

  // ── Pass 1: Reclassify existing URLs ────────────────────────────────────────
  console.log('\n══ Pass 1: Reclassify existing URLs ════════════════════════════════');
  let totalFixed = 0;
  for (const code of TARGET_STATES) {
    const { fixed, total } = reclassifyState(db, code);
    console.log(`  ${code}: reclassified ${fixed}/${total} entries`);
    totalFixed += fixed;
  }
  console.log(`\n  Total reclassified: ${totalFixed}`);
  saveDb(db);
  console.log('  [saved]');

  if (RECLASSIFY_ONLY) {
    console.log('\nReclassify-only mode — skipping network passes.\n');
    return;
  }

  // ── Pass 2: Pattern probe for all target states (Vision / Patriot URLs) ──────
  console.log('\n══ Pass 2: Pattern probe (Vision / Patriot) for all NE states ════════');
  let totalProbeFilled = 0;

  for (const code of TARGET_STATES) {
    const stateEntries = db.states[code] || {};
    const nulls = Object.entries(stateEntries)
      .filter(([k, v]) => k !== '_done' && !v.url);

    if (nulls.length === 0) {
      console.log(`  ${code}: no nulls to probe`);
      continue;
    }

    console.log(`  ${code}: probing ${nulls.length} null entries`);
    let stateFilled = 0;

    for (const [name, entry] of nulls) {
      process.stdout.write(`  ${name}...`);
      const found = await probePatterns(name, code);
      if (found) {
        entry.url      = found.url;
        entry.platform = found.platform;
        process.stdout.write(` ✓ [${found.platform}] ${found.url}\n`);
        stateFilled++;
        totalProbeFilled++;
      } else {
        process.stdout.write(' (not found via patterns)\n');
      }
      await sleep(DELAY_MS);
    }

    console.log(`  ${code}: pattern probe filled ${stateFilled}/${nulls.length}`);
  }

  console.log(`\n  Total pattern probe filled: ${totalProbeFilled}`);
  saveDb(db);
  console.log('  [saved]');

  // ── Pass 3: Netronline refetch for all remaining nulls ───────────────────────
  console.log('\n══ Pass 3: Netronline refetch for remaining nulls ══════════════════');

  let refetchTotal = 0;
  let refetchFilled = 0;

  for (const code of TARGET_STATES) {
    const stateEntries = db.states[code] || {};
    const nulls = Object.entries(stateEntries)
      .filter(([k, v]) => k !== '_done' && !v.url);

    if (nulls.length === 0) {
      console.log(`  ${code}: no nulls remaining`);
      continue;
    }

    console.log(`\n  ${code}: ${nulls.length} null entries to refetch`);

    for (const [name, entry] of nulls) {
      refetchTotal++;
      process.stdout.write(`    ${name}...`);

      if (!entry.netronlinePath) {
        process.stdout.write(' (no netronline path — skipping)\n');
        continue;
      }

      try {
        const url = await refetchFromNetronline(entry.netronlinePath);
        if (url) {
          entry.url      = url;
          entry.platform = detectFromUrl(url);
          process.stdout.write(` ✓ [${entry.platform}] ${url.substring(0, 60)}\n`);
          refetchFilled++;
        } else {
          process.stdout.write(' (no URL found)\n');
        }
      } catch (err) {
        process.stdout.write(` ✗ ${err.message}\n`);
      }

      await sleep(DELAY_MS);
    }

    // Save after each state
    saveDb(db);
    console.log(`  [saved] ${code}`);
  }

  console.log(`\n  Netronline refetch: filled ${refetchFilled}/${refetchTotal}`);

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n══ Final summary ════════════════════════════════════════════════════');
  for (const code of TARGET_STATES) {
    const entries = Object.entries(db.states[code] || {}).filter(([k]) => k !== '_done');
    const total   = entries.length;
    const hasUrl  = entries.filter(([, v]) => v.url).length;
    const patriot = entries.filter(([, v]) => v.platform === 'patriot').length;
    const vision  = entries.filter(([, v]) => v.platform === 'vision').length;
    const generic = entries.filter(([, v]) => v.platform === 'generic').length;
    const nulls   = total - hasUrl;
    console.log(
      `  ${code}: ${hasUrl}/${total} have URLs  |  patriot=${patriot}  vision=${vision}  generic=${generic}  null=${nulls}`
    );
  }

  console.log('\n✅ Done\n');
}

main().catch(err => { console.error(err); process.exit(1); });
