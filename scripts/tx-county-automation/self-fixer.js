'use strict';

/**
 * self-fixer.js
 *
 * Analyses test results and automatically applies fixes where safe:
 *   1. Platform re-identification  — updates counties.json platform field
 *      when a URL fingerprint matches a known platform
 *   2. URL replacement             — swaps dead URLs for live ones from
 *      Netronline (via the /api/county-sources endpoint)
 *   3. Fix log                     — every change is recorded so the
 *      report can show what was changed automatically
 */

const path = require('path');
const fs   = require('fs');
const http  = require('http');
const https = require('https');

const COUNTIES_JSON = path.resolve(__dirname, '../../data/counties.json');

// ─── Platform fingerprints ─────────────────────────────────────────────────────
// Listed from most specific to most generic.
const PLATFORM_FINGERPRINTS = [
  {
    platform: 'bis',
    // Classic: esearch.{county}cad.org  |  SPA: *.cadcentral.com or *.bisconsultants.com
    // Also detect navigated search result URLs: /search/result?keywords=
    test: (url) => (
      /esearch\.[a-z]+cad\.(org|com|net)/i.test(url) ||
      /\.cadcentral\.com/i.test(url) ||
      /\.bisconsultants\.com/i.test(url) ||
      /\/search\/result\?keywords=/i.test(url)
    ),
    label: 'BIS Consultants',
  },
  {
    platform: 'publicportal',
    test: (url) => /aumentum|public-access|pubportlet|andersoncad\.net|harrisoncad\.net|somervellcad\.net|tylercad\.net|woodcad\.net/i.test(url),
    label: 'Aumentum / Public Portal',
  },
  {
    platform: 'tyler',
    test: (url) => /tylertech|iasworld|idatamgt\.com|propertytax\.tylertech/i.test(url),
    label: 'Tyler Technologies iasWorld',
  },
  {
    platform: 'qpublic',
    test: (url) => /qpublic\.net|qpublic\.schneidercorp|schneidercorp\.com/i.test(url),
    label: 'Schneider Corp / qPublic',
  },
  {
    platform: 'beacon',
    test: (url) => /beacon\.schneidercorp|assessor\.beacon/i.test(url),
    label: 'Beacon Schneider',
  },
  {
    platform: 'trueautomation',
    test: (url) => /trueautomation\.com|propaccess\.trueautomation/i.test(url),
    label: 'True Automation / ProAccess',
  },
  {
    platform: 'prodigycad',
    test: (url) => /prodigycad\.com/i.test(url),
    label: 'ProdigyCAD',
  },
  {
    platform: 'isw',
    test: (url) => /iswdataclient\.azurewebsites\.net/i.test(url),
    label: 'ISW Data Client (Azure)',
  },
  {
    platform: 'countyfusion',
    test: (url) => /kofiletech\.us|countyfusion/i.test(url),
    label: 'County Fusion (Kofile)',
  },
  {
    platform: 'governmax',
    test: (url) => /governmax|govern\.com/i.test(url),
    label: 'GovernMax',
  },
];

// ─── Detect platform from URL ─────────────────────────────────────────────────

function detectPlatformFromUrl(url) {
  if (!url) return null;
  for (const fp of PLATFORM_FINGERPRINTS) {
    if (fp.test(url)) return { platform: fp.platform, label: fp.label };
  }
  return null;
}

// ─── Simple HTTP GET ──────────────────────────────────────────────────────────

function httpGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end',  () => resolve({ status: res.statusCode, body }));
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Fetch alternative URLs for a county from the server's sources endpoint ───

async function fetchAlternativeUrls(serverUrl, state, county) {
  try {
    const res = await httpGet(
      `${serverUrl}/api/county-sources?state=${encodeURIComponent(state)}&county=${encodeURIComponent(county)}`,
      8000
    );
    if (res.status !== 200) return [];
    const data = JSON.parse(res.body);
    const sources = data.sources || data || [];
    if (!Array.isArray(sources)) return [];
    // Filter: prefer CAD/appraisal sources; exclude Clerks, mapping, aerial, subscription-only
    return sources
      .filter(s => {
        const nameL = (s.name || '').toLowerCase();
        const textL = (s.onlineText || '').toLowerCase();
        // Exclude clerk offices, historic aerials, mapping, subscription services
        if (nameL.includes('clerk')) return false;
        if (nameL.includes('aerial') || nameL.includes('mapping') || nameL.includes('gis')) return false;
        if (textL.includes('subscription only')) return false;
        // Include appraisal districts and tax offices
        return nameL.includes('appraisal') || nameL.includes('cad') || nameL.includes('tax office')
          || s.type === 'appraisal' || s.type === 'search';
      })
      .map(s => s.onlineUrl || s.url || s.link)
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

// ─── Check if a URL is alive ──────────────────────────────────────────────────

async function isUrlAlive(url) {
  try {
    const lib = (url || '').startsWith('https') ? https : http;
    return await new Promise((resolve) => {
      const req = lib.get(url, { timeout: 8000 }, (res) => {
        req.destroy();
        resolve(res.statusCode < 500);
      });
      req.on('error',   () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  } catch (_) {
    return false;
  }
}

// ─── Apply fixes to counties.json ─────────────────────────────────────────────

function loadCountiesJson() {
  return JSON.parse(fs.readFileSync(COUNTIES_JSON, 'utf8'));
}

function saveCountiesJson(data) {
  data.lastUpdated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(COUNTIES_JSON, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Main fix runner ──────────────────────────────────────────────────────────

async function runSelfFixer(allTestResults, serverUrl = 'http://localhost:3000', options = {}) {
  const dryRun  = options.dryRun  ?? false;
  const verbose = options.verbose ?? false;

  const fixLog  = [];
  const data    = loadCountiesJson();
  let   changed = false;

  console.log(`\n[self-fixer] Analysing ${allTestResults.length} test results (dryRun=${dryRun})...`);

  for (const result of allTestResults) {
    const { county, state, platform, url } = result;
    const countyEntry = data.states?.[state]?.[county];
    if (!countyEntry) continue;

    // ── Fix 1: Re-identify platform from URL ──────────────────────────────────
    // Also check the URL the handler actually navigated to (nameSearch.searchedUrl)
    // since BIS SPAs redirect to /Property/Search after form submission.
    const navigatedUrl = result.nameSearch?.searchedUrl || result.idSearch?.searchedUrl;
    const detected = detectPlatformFromUrl(url) || detectPlatformFromUrl(navigatedUrl);
    if (detected && (!platform || platform === 'generic') && detected.platform !== platform) {
      const fix = {
        county,
        state,
        type: 'platform_update',
        oldPlatform: platform || 'generic',
        newPlatform: detected.platform,
        label: detected.label,
        url,
        reason: 'URL fingerprint matched known platform',
      };
      fixLog.push(fix);
      if (verbose) console.log(`  [fix] ${county}: platform ${fix.oldPlatform} → ${fix.newPlatform} (${fix.label})`);
      if (!dryRun) {
        countyEntry.platform = detected.platform;
        changed = true;
      }
    }

    // ── Fix 2: Try to find a live URL for no_url / error / no_results counties
    if ((result.status === 'no_url' || result.status === 'error' || result.status === 'no_results') && serverUrl) {
      const alts = await fetchAlternativeUrls(serverUrl, state, county);
      for (const altUrl of alts) {
        const alive = await isUrlAlive(altUrl);
        if (alive) {
          const detectedAlt = detectPlatformFromUrl(altUrl);
          const fix = {
            county,
            state,
            type: 'url_update',
            oldUrl: url || '(none)',
            newUrl: altUrl,
            newPlatform: detectedAlt?.platform || countyEntry.platform || 'generic',
            reason: `Alternative URL from county-sources (status was: ${result.status})`,
          };
          fixLog.push(fix);
          if (verbose) console.log(`  [fix] ${county}: URL → ${altUrl} (alive)`);
          if (!dryRun) {
            countyEntry.url      = altUrl;
            countyEntry.platform = fix.newPlatform;
            countyEntry.lastVerified = new Date().toISOString().slice(0, 10);
            changed = true;
          }
          break; // first live URL wins
        }
      }
    }
  }

  // ── Save changes ─────────────────────────────────────────────────────────────
  if (changed && !dryRun) {
    saveCountiesJson(data);
    console.log(`[self-fixer] Saved ${fixLog.filter(f => !dryRun).length} fixes to counties.json`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const platformUpdates = fixLog.filter(f => f.type === 'platform_update').length;
  const urlUpdates      = fixLog.filter(f => f.type === 'url_update').length;

  console.log(`[self-fixer] Done. Platform updates: ${platformUpdates}, URL updates: ${urlUpdates}`);

  return {
    fixLog,
    platformUpdates,
    urlUpdates,
    totalFixes: fixLog.length,
    dryRun,
  };
}

// ─── Identify new platform groups (for handler roadmap) ───────────────────────

function identifyPlatformGroups(allTestResults) {
  const failingByPlatform = {};

  for (const r of allTestResults) {
    if (r.status === 'pass' || r.status === 'no_url') continue;
    const plat = r.platform || 'unknown';
    if (!failingByPlatform[plat]) failingByPlatform[plat] = { counties: [], statuses: {} };
    failingByPlatform[plat].counties.push(r.county);
    failingByPlatform[plat].statuses[r.status] = (failingByPlatform[plat].statuses[r.status] || 0) + 1;
  }

  // Identify URL-based groups within generic for new handler candidates
  const urlGroups = {};
  for (const r of allTestResults) {
    if (!r.url || r.status === 'pass' || r.status === 'no_url') continue;
    if (r.platform !== 'generic') continue;
    try {
      const hostname = new URL(r.url).hostname.replace(/^www\./, '');
      const parts = hostname.split('.');
      // Group by TLD+1 domain (e.g., trueautomation.com)
      const domain = parts.slice(-2).join('.');
      if (!urlGroups[domain]) urlGroups[domain] = [];
      urlGroups[domain].push(r.county);
    } catch (_) {}
  }

  // Only report groups with 2+ failing counties — worth building a handler for
  const handlerCandidates = Object.entries(urlGroups)
    .filter(([, counties]) => counties.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([domain, counties]) => ({ domain, counties, count: counties.length }));

  return { failingByPlatform, handlerCandidates };
}

module.exports = { runSelfFixer, detectPlatformFromUrl, identifyPlatformGroups, isUrlAlive };
