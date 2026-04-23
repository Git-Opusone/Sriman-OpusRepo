'use strict';

/**
 * scripts/buildCountyDirectory.js
 *
 * One-time build script — scrapes publicrecords.netronline.com and produces
 * data/counties.json  (State → County → { url, platform, ... })
 *
 * Usage:  node scripts/buildCountyDirectory.js
 *
 * Saves progress after every state so it can be safely interrupted and
 * resumed.  Already-completed states are skipped on re-run.
 */

require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE       = 'https://publicrecords.netronline.com';
const OUT_FILE   = path.join(__dirname, '../data/counties.json');
const DELAY_MS   = 600;   // pause between requests (be polite)
const RETRY_MAX  = 3;
const TIMEOUT_MS = 15000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

const STATES = {
  AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California',
  CO:'Colorado', CT:'Connecticut', DE:'Delaware', DC:'District of Columbia',
  FL:'Florida', GA:'Georgia', HI:'Hawaii', ID:'Idaho', IL:'Illinois',
  IN:'Indiana', IA:'Iowa', KS:'Kansas', KY:'Kentucky', LA:'Louisiana',
  ME:'Maine', MD:'Maryland', MA:'Massachusetts', MI:'Michigan', MN:'Minnesota',
  MS:'Mississippi', MO:'Missouri', MT:'Montana', NE:'Nebraska', NV:'Nevada',
  NH:'New Hampshire', NJ:'New Jersey', NM:'New Mexico', NY:'New York',
  NC:'North Carolina', ND:'North Dakota', OH:'Ohio', OK:'Oklahoma', OR:'Oregon',
  PA:'Pennsylvania', RI:'Rhode Island', SC:'South Carolina', SD:'South Dakota',
  TN:'Tennessee', TX:'Texas', UT:'Utah', VT:'Vermont', VA:'Virginia',
  WA:'Washington', WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming',
};

// URL-based patterns that identify known property search platforms (highest confidence)
const PLATFORM_URL_PATTERNS = [
  'qpublic.net', 'schneidercorp.com', 'tylerhost.net', 'iasworld',
  'tylertech.com', 'patriotproperties.com', 'visionappraisal.com', 'vgsi.com',
  'bisconsultants.com', 'cadcentral.com',
];

// URL path/domain keywords indicating a county property search site
const PROPERTY_URL_KEYWORDS = [
  'assessor', 'appraisal', 'cad.org', 'propertysearch', 'property-search',
  'propertytax', 'property-tax', 'taxoffice', 'tax-office', 'taxsearch',
  'treasurer', 'taxcollect', 'taxassessor', 'revenue',
];

// Context/section heading keywords (checked against nearby parent text on the page)
const PROPERTY_CONTEXT_KEYWORDS = [
  'assessor', 'appraisal', 'tax commissioner', 'tax assessor',
  'property tax', 'tax office', 'treasurer', 'revenue',
];

// Link-text / href substrings that are NOT property search
const SKIP_TEXT = [
  'clerk','recorder','gis','mapping','aerial','register of deeds',
  'vital','sos.','secretary of state','ucc','corporation','historic',
  'school district','isd tax','msd tax','hospital district',
];
const SKIP_HREF = [
  'netronline.com','historicaerials.com','datastore.',
  'map.netronline','ncleg.gov',
  // State government portals — never the right county property search link
  'myfloridacounty.com','georgia.gov','az.gov','texas.gov','ca.gov',
  'state.al.us','state.ak.us','state.ar.us','state.co.us','state.ct.us',
  'state.de.us','state.hi.us','state.id.us','state.il.us','state.in.us',
  'state.ia.us','state.ks.us','state.ky.us','state.la.us','state.me.us',
  'state.md.us','state.ma.us','state.mi.us','state.mn.us','state.ms.us',
  'state.mo.us','state.mt.us','state.ne.us','state.nv.us','state.nh.us',
  'state.nj.us','state.nm.us','state.ny.us','state.nc.us','state.nd.us',
  'state.oh.us','state.ok.us','state.or.us','state.pa.us','state.ri.us',
  'state.sc.us','state.sd.us','state.tn.us','state.ut.us','state.vt.us',
  'state.va.us','state.wa.us','state.wv.us','state.wi.us','state.wy.us',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHtml(url) {
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT_MS });
      return res.data;
    } catch (err) {
      if (attempt === RETRY_MAX) throw err;
      await sleep(DELAY_MS * attempt);
    }
  }
}

function detectPlatform(url) {
  if (!url) return 'unknown';
  const u = url.toLowerCase();
  if (u.includes('qpublic.net'))                          return 'qpublic';
  if (u.includes('beacon.schneidercorp.com') ||
      u.includes('schneidercorp.com'))                    return 'beacon';
  if (u.includes('tylerhost.net') ||
      u.includes('iasworld') ||
      u.includes('tylertech'))                            return 'tyler';
  if (u.includes('patriotproperties.com'))                return 'patriot';
  if (u.includes('visionappraisal.com') ||
      u.includes('vgsi.com'))                             return 'vision';
  if (u.includes('esearch') ||
      u.includes('bisconsultants') ||
      u.includes('cadcentral'))                           return 'bis';
  if (u.includes('acgov') || u.includes('co.') ||
      u.includes('county'))                               return 'generic';
  return 'generic';
}

function scoreUrl(href, text, context) {
  const h = href.toLowerCase();
  const t = text.toLowerCase();
  const c = (context || '').toLowerCase();
  let score = 0;

  // Known platform URLs are highest confidence
  if (PLATFORM_URL_PATTERNS.some(p => h.includes(p))) score += 100;

  // URL path contains property-related keywords
  if (PROPERTY_URL_KEYWORDS.some(p => h.includes(p))) score += 50;

  // Link text or surrounding context mentions property/assessment
  if (PROPERTY_CONTEXT_KEYWORDS.some(k => t.includes(k) || c.includes(k))) score += 30;

  // "Go to Data Online" is netronline's standard label for ALL property search links
  if (t.includes('go to data online') || t.includes('data online')) score += 10;

  return score;
}

function pickBestUrl(links) {
  // Filter out clearly irrelevant links
  const candidates = links.filter(({ text, href }) => {
    const t = text.toLowerCase();
    const h = href.toLowerCase();
    if (SKIP_HREF.some(s => h.includes(s))) return false;
    if (SKIP_TEXT.some(s => t.includes(s))) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // Score each candidate and return the highest
  const scored = candidates.map(l => ({
    ...l,
    score: scoreUrl(l.href, l.text, l.context || ''),
  }));

  scored.sort((a, b) => b.score - a.score);

  // Debug: log top candidates
  const top = scored.slice(0, 3);
  top.forEach(l => process.stdout.write(`    [score ${l.score}] ${l.text.substring(0,40)} → ${l.href.substring(0,60)}\n`));

  return scored[0].score > 0 ? scored[0].href : null;
}

// ─── Scrapers ────────────────────────────────────────────────────────────────

async function getCountiesForState(stateCode) {
  const html = await fetchHtml(`${BASE}/state/${stateCode}`);
  const $    = cheerio.load(html);
  const counties = [];
  $('a[href*="/county/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const name = $(el).text().trim();
    if (href && name && href.includes(`/state/${stateCode}/county/`)) {
      counties.push({ name, path: href });
    }
  });
  return counties;
}

async function getPropertyUrlForCounty(countyPath) {
  const html  = await fetchHtml(`${BASE}${countyPath}`);
  const $     = cheerio.load(html);
  const links = [];

  $('a[href^="http"]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    const text = $(el).text().trim();
    if (!href || !text) return;

    // Capture nearest heading or section label as context (helps score "Assessor" sections)
    const $el       = $(el);
    const $section  = $el.closest('div,section,li,tr');
    const context   = $section.find('h1,h2,h3,h4,h5,strong,b,th').first().text().trim()
                   || $section.text().trim().substring(0, 120);

    links.push({ href, text, context });
  });

  return pickBestUrl(links);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Load existing output (for resume support)
  let db = { version: '1.0', lastUpdated: '', states: {} };
  if (fs.existsSync(OUT_FILE)) {
    try { db = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (_) {}
  }

  const stateCodes = Object.keys(STATES);
  let totalCounties = 0;
  let totalFailed   = 0;

  for (const code of stateCodes) {
    if (db.states[code]?._done) {
      const n = Object.keys(db.states[code]).filter(k => k !== '_done').length;
      console.log(`[skip] ${code} — already done (${n} counties)`);
      totalCounties += n;
      continue;
    }

    console.log(`\n[state] ${code} — ${STATES[code]}`);
    if (!db.states[code]) db.states[code] = {};

    let counties;
    try {
      counties = await getCountiesForState(code);
      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`  ✗ Failed to fetch counties for ${code}: ${err.message}`);
      continue;
    }

    console.log(`  Found ${counties.length} counties`);

    for (const { name, path: countyPath } of counties) {
      process.stdout.write(`  ${name}...`);
      try {
        const url = await getPropertyUrlForCounty(countyPath);
        db.states[code][name] = {
          url:              url || null,
          platform:         detectPlatform(url),
          lastVerified:     null,
          netronlinePath:   countyPath,
        };
        process.stdout.write(url ? ` ✓ ${url.substring(0, 60)}\n` : ' (no URL found)\n');
        totalCounties++;
      } catch (err) {
        process.stdout.write(` ✗ ${err.message}\n`);
        db.states[code][name] = { url: null, platform: 'unknown', lastVerified: null, netronlinePath: countyPath };
        totalFailed++;
      }
      await sleep(DELAY_MS);
    }

    // Mark state complete and save progress
    db.states[code]._done    = true;
    db.lastUpdated            = new Date().toISOString().split('T')[0];
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(db, null, 2));
    console.log(`  [saved] ${code} complete`);
  }

  console.log(`\n✅ Done — ${totalCounties} counties, ${totalFailed} failed`);
  console.log(`   Output: ${OUT_FILE}`);
}

main().catch(err => { console.error(err); process.exit(1); });
