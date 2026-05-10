'use strict';
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const DB_PATH = './data/counties.json';
const BASE = 'https://publicrecords.netronline.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*',
};
const SKIP_HREF = ['netronline.com','historicaerials.com','datastore.','map.netronline','texas.gov','myfloridacounty.com'];
const SKIP_TEXT = ['clerk','recorder','gis','mapping','aerial','register of deeds','vital','ucc','corporation'];
const PLATFORM_PATTERNS = ['qpublic.net','schneidercorp.com','iasworld','tylertech.com','patriotproperties.com','visionappraisal.com','vgsi.com','bisconsultants.com','cadcentral.com'];
const SKIP_HREF_EXTRA = ['countytx-web.tylerhost','selfservice.tylerhost','-web.tylerhost.net/web/search/DOC','-web.tylerhost.net/williamson'];

function detectFromUrl(url) {
  const u = (url||'').toLowerCase();
  if (u.includes('qpublic.net')) return 'qpublic';
  if (u.includes('schneidercorp')) return 'beacon';
  if (u.includes('iasworld') || u.includes('tylertech')) return 'tyler';
  if (u.includes('patriotproperties')) return 'patriot';
  if (u.includes('visionappraisal') || u.includes('vgsi')) return 'vision';
  if (u.includes('bisconsultants') || u.includes('cadcentral') || u.includes('esearch')) return 'bis';
  return 'generic';
}

function scoreUrl(href, text) {
  const h = href.toLowerCase(); const t = text.toLowerCase();
  if (SKIP_HREF_EXTRA.some(p => h.includes(p))) return -1;
  let score = 0;
  if (PLATFORM_PATTERNS.some(p => h.includes(p))) score += 100;
  if (h.includes('cad.org') || h.includes('cad.net') || h.includes('appraisal') || h.includes('assessor')) score += 80;
  if (t.includes('appraisal') || t.includes('assessor') || t.includes('cad') || t.includes('property')) score += 30;
  return score;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchBest(netronlinePath) {
  const res = await axios.get(`${BASE}${netronlinePath}`, { headers: HEADERS, timeout: 12000, validateStatus: () => true });
  if (res.status >= 400) return null;
  const $ = cheerio.load(res.data);
  const links = [];
  $('a[href^="http"]').each((_, el) => {
    const href = ($(el).attr('href')||'').trim();
    const text = $(el).text().trim();
    if (!href || !text) return;
    if (SKIP_HREF.some(s => href.toLowerCase().includes(s))) return;
    if (SKIP_TEXT.some(s => text.toLowerCase().includes(s))) return;
    links.push({ href, text });
  });
  const scored = links.map(l => ({ ...l, score: scoreUrl(l.href, l.text) }))
    .filter(l => l.score >= 0)
    .sort((a, b) => b.score - a.score);
  return (scored.length > 0 && scored[0].score > 0) ? scored[0] : null;
}

async function main() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const tx = db.states['TX'];
  const nulls = Object.entries(tx).filter(([k,v]) => k !== '_done' && !v.url && v.netronlinePath);
  console.log(`Refetching ${nulls.length} null TX entries from netronline...\n`);
  let filled = 0;
  for (const [name, entry] of nulls) {
    process.stdout.write(`  ${name}...`);
    try {
      const best = await fetchBest(entry.netronlinePath);
      if (best) {
        entry.url = best.href;
        entry.platform = detectFromUrl(best.href);
        process.stdout.write(` ✓ [${entry.platform}] ${best.href}\n`);
        filled++;
      } else {
        process.stdout.write(` (not found)\n`);
      }
    } catch(e) { process.stdout.write(` ✗ ${e.message}\n`); }
    await sleep(600);
  }
  db.lastUpdated = new Date().toISOString().split('T')[0];
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  console.log(`\nFilled ${filled}/${nulls.length}. Saved.`);
}
main().catch(console.error);
