'use strict';
/**
 * Discovers Tax Assessor-Collector URLs for TX counties that don't have one yet.
 * Tests common URL patterns with HTTP HEAD requests (fast, no browser needed).
 *
 * Run: node scripts/tx-county-automation/discover-tax-urls.js
 *
 * Output: reports/discovered-tax-urls.json  — counties with discovered URLs
 *         reports/discovered-tax-urls-log.txt — per-county results
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const COUNTIES_JSON = path.join(__dirname, '../../data/counties.json');
const REPORT_DIR    = path.join(__dirname, 'reports');
const OUT_JSON      = path.join(REPORT_DIR, 'discovered-tax-urls.json');
const OUT_LOG       = path.join(REPORT_DIR, 'discovered-tax-urls-log.txt');

const TIMEOUT_MS = 8000;
const CONCURRENCY = 8;

// URL patterns to test, in order. {county} = lowercase county name (no spaces/special chars)
// {countyRaw} = lowercase original name, {countyDash} = hyphenated
const PATTERNS = [
  // TX County Tax Office Kendo (tax.co.{county}.tx.us)
  { template: 'http://tax.co.{county}.tx.us/', platform: 'txcountytax' },
  { template: 'https://tax.co.{county}.tx.us/', platform: 'txcountytax' },
  // ACTweb
  { template: 'https://actweb.acttax.com/act_webdev/{county}/index.jsp', platform: 'actweb' },
  { template: 'https://{county}.acttax.com/act_webdev/{county}/index.jsp', platform: 'actweb' },
  // propertytaxpayments.net
  { template: 'https://{county}.propertytaxpayments.net/search', platform: 'generic' },
  { template: 'https://{countyDash}.propertytaxpayments.net/search', platform: 'generic' },
  // county gov tax portals
  { template: 'https://tax.{county}countytx.gov/', platform: 'generic' },
  { template: 'https://tax.{county}countytx.gov/search', platform: 'generic' },
  { template: 'https://property.co.{county}.tx.us/search', platform: 'generic' },
  { template: 'https://property.{county}tx.gov/', platform: 'generic' },
  { template: 'https://taxpayer.{county}county.com/taxweb/', platform: 'generic' },
  { template: 'https://{county}countytax.com/search', platform: 'generic' },
  { template: 'https://www.{county}countytax.com/search', platform: 'generic' },
  { template: 'https://{county}tax.com/', platform: 'generic' },
  { template: 'https://www.{county}tax.com/', platform: 'generic' },
];

function slug(name) {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}
function slugDash(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z-]/g, '');
}

function fillTemplate(tmpl, name) {
  const c = slug(name);
  const cd = slugDash(name);
  return tmpl.replace(/\{county\}/g, c).replace(/\{countyDash\}/g, cd).replace(/\{countyRaw\}/g, name.toLowerCase());
}

function checkUrl(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => { req.destroy(); resolve({ ok: false, status: 0 }); }, TIMEOUT_MS);
    const req = mod.request(url, { method: 'HEAD', timeout: TIMEOUT_MS, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      clearTimeout(timeout);
      const status = res.statusCode;
      // 200, 302, 301 = exists; 403 = blocked but exists; 404/5xx = not found
      const ok = status < 400 || status === 403;
      resolve({ ok, status });
    });
    req.on('error', () => { clearTimeout(timeout); resolve({ ok: false, status: 0 }); });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.end();
  });
}

async function processQueue(queue, workers) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < queue.length) {
      const item = queue[i++];
      const result = await item();
      if (result) results.push(result);
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

async function main() {
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

  const data = JSON.parse(fs.readFileSync(COUNTIES_JSON, 'utf8'));
  const tx = data.states.TX;

  const needsTaxUrl = Object.entries(tx)
    .filter(([k, v]) => k !== '_done' && v && v.url && !v.taxUrl)
    .map(([k]) => k);

  console.log(`Counties needing taxUrl: ${needsTaxUrl.length}`);

  const logLines = [];
  const discovered = {};
  let tested = 0;
  let found = 0;

  const queue = [];
  for (const county of needsTaxUrl) {
    queue.push(async () => {
      const results = [];
      for (const pat of PATTERNS) {
        const url = fillTemplate(pat.template, county);
        const { ok, status } = await checkUrl(url);
        if (ok) {
          results.push({ url, platform: pat.platform, status });
        }
      }

      tested++;
      process.stdout.write(`\r${tested}/${needsTaxUrl.length} tested, ${found} found`);

      if (results.length > 0) {
        // Pick best: prefer txcountytax > actweb > generic; prefer 200/301/302 over 403
        results.sort((a, b) => {
          const rank = { txcountytax: 0, actweb: 1, generic: 2 };
          if (rank[a.platform] !== rank[b.platform]) return rank[a.platform] - rank[b.platform];
          // prefer non-403
          if ((a.status === 403) !== (b.status === 403)) return a.status === 403 ? 1 : -1;
          return 0;
        });
        const best = results[0];
        discovered[county] = { taxUrl: best.url, taxPlatform: best.platform, status: best.status, alternates: results.slice(1) };
        found++;
        const log = `FOUND ${county}: ${best.url} [${best.platform}] status=${best.status}`;
        logLines.push(log);
        console.log('\n' + log);
        return { county, ...best };
      } else {
        logLines.push(`NOT FOUND: ${county}`);
        return null;
      }
    });
  }

  await processQueue(queue, CONCURRENCY);

  console.log(`\n\nDone. Found: ${found}/${needsTaxUrl.length}`);

  fs.writeFileSync(OUT_JSON, JSON.stringify(discovered, null, 2));
  fs.writeFileSync(OUT_LOG, logLines.join('\n'));
  console.log(`Results: ${OUT_JSON}`);
  console.log(`Log:     ${OUT_LOG}`);

  // Show summary of what was found
  const byPlatform = {};
  Object.values(discovered).forEach(d => {
    byPlatform[d.taxPlatform] = (byPlatform[d.taxPlatform] || 0) + 1;
  });
  console.log('\nFound by platform:');
  Object.entries(byPlatform).forEach(([p, n]) => console.log(' ', p, ':', n));
}

main().catch(console.error);
