'use strict';

/**
 * src/agents/stateAgent.js
 *
 * One state's maintenance agent. For every county in the directory it:
 *   1. probes the appraisal (CAD) search through the app's own /api/tax/search/stream
 *      — the exact pipeline users hit — with sample surnames
 *   2. classifies the result (healthy / degraded_ai / blocked / site_down / …)
 *   3. for dead or failing URLs, tries the county's other NETR-listed appraisal
 *      URLs and, if one returns records, saves it as a verified URL override
 *   4. asks the LLM for a likely cause on the remaining unclear failures
 *   5. flags regressions against the previous run and records baselines
 *
 * Probes wait for a free search slot so they never crowd out user searches.
 */

const store = require('./store');
const { classify, aiDiagnose } = require('./diagnose');
const { getCountiesForState, getCountyUrl } = require('../shared/countyDirectory');
const { checkUrlHealth, getAllNetronlineSources } = require('../shared/urlHealthCheck');
const { detectFromUrl } = require('../shared/platformDetector');

const SAMPLE_SURNAMES = ['Smith', 'Johnson'];
const PROBE_TIMEOUT_MS = 240000;
const GOOD = new Set(['healthy', 'degraded_ai']);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wait until at least one search slot stays free for users
async function waitForSlot() {
  const { getActiveSearches, MAX_CONCURRENT } = require('../tax/routes');
  for (let i = 0; getActiveSearches() >= Math.max(1, MAX_CONCURRENT - 1) && i < 120; i++) await sleep(5000);
}

/**
 * One search through the public SSE endpoint. Returns
 * { status: ok|none|captcha|error|timeout, n, owner, id, engine, summary, searchedUrl, progress[], secs }
 */
async function probe(baseUrl, { state, county, lastName, url }) {
  const qs = new URLSearchParams({ state, county, lastName, forceRefresh: 'true' });
  if (url) qs.set('url', url);
  const t = Date.now();
  const out = { status: '', progress: [] };

  for (let attempt = 0; attempt < 6; attempt++) {
    await waitForSlot();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/api/tax/search/stream?${qs}`, { signal: ac.signal });
      if (res.status === 503) { clearTimeout(timer); await sleep(20000); continue; }   // busy — retry
      if (!res.ok) { out.status = 'error'; out.summary = `HTTP ${res.status}`; break; }
      const dec = new TextDecoder();
      let buf = '', ev = '';
      read: for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (line.startsWith('event:')) { ev = line.slice(6).trim(); continue; }
          if (!line.startsWith('data:')) continue;
          let d; try { d = JSON.parse(line.slice(5)); } catch (_) { continue; }
          if (ev === 'status' || ev === 'progress') {
            out.progress.push(String(d.message || '').slice(0, 200));
            if (out.progress.length > 12) out.progress.shift();
          } else if (ev === 'results') {
            const recs = d.records || [];
            Object.assign(out, {
              status: recs.length ? 'ok' : (d.captchaBlocked ? 'captcha' : 'none'),
              n: d.totalFound ?? recs.length,
              owner: String(recs[0]?.ownerName || '').split('\n')[0].slice(0, 60),
              id: String(recs[0]?.parcelId || '').slice(0, 40),
              engine: d.engine || 'ai',
              summary: String(d.summary || '').slice(0, 300),
              searchedUrl: d.searchedUrl || '',
            });
          } else if (ev === 'captcha') {
            out.status = 'captcha'; out.summary = `CAPTCHA: ${d.type || 'detected'}`;
          } else if (ev === 'error') {
            out.status = 'error'; out.summary = String(d.message || '').slice(0, 300);
          } else if (ev === 'done') break read;
        }
      }
    } catch (err) {
      out.status = out.status || (err.name === 'AbortError' ? 'timeout' : 'error');
      out.summary = out.summary || err.message;
    } finally {
      clearTimeout(timer);
    }
    break;
  }
  out.status = out.status || 'error';
  out.secs = Math.round((Date.now() - t) / 1000);
  return out;
}

async function probeCounty(baseUrl, state, county, url) {
  let p;
  for (const lastName of SAMPLE_SURNAMES) {
    p = await probe(baseUrl, { state, county, lastName, url });
    p.surname = lastName;
    if (p.status !== 'none') break;   // only "found nothing" is worth a second surname
  }
  return p;
}

const sameUrl = (a, b) => String(a || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '').toLowerCase()
  === String(b || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '').toLowerCase();

/**
 * Try other URLs for the county: the original directory URL first (when the
 * failing one is an earlier agent override), then its NETR-listed appraisal
 * URLs. A candidate is only accepted after a real search through it returns
 * records; one served by a dedicated handler beats one that needed the AI fallback.
 */
// Tax-collector / payment portals hold tax bills, not appraisal records — never
// accept one as a county's appraisal URL (the Tax Office tab covers those)
const TAX_SITE = /propertytaxpayments\.net|acttax\.com|act_webdev|taxpayment|tax-?office|taxoffice|\.tax\.|ptax/i;

// Search portals linked from a CAD's homepage (e.g. collincad.org → esearch.collincad.org)
const SEARCH_LINK = /\/\/(esearch|search|propaccess|prodigy|property)[.-]|property-?search|propertysearch|\/search\b/i;

async function homepageSearchLinks(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' } });
    if (!res.ok) return [];
    const html = await res.text();
    const host = new URL(res.url).hostname.replace(/^www\./, '');
    const root = host.split('.').slice(-2).join('.');
    const links = [...html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)]
      .map(m => { try { return new URL(m[1], res.url).href; } catch (_) { return null; } })
      .filter(u => u && /^https?:/i.test(u) && SEARCH_LINK.test(u) && !TAX_SITE.test(u)
        // same organisation only: a subdomain of the CAD's own domain
        && new URL(u).hostname.replace(/^www\./, '').endsWith(root)
        && !/site-?search|\.pdf$|wp-content|\/help/i.test(u));
    return [...new Set(links)].slice(0, 2);
  } catch (_) { return []; }
}

async function tryRepair(baseUrl, state, county, entry, runId) {
  const currentUrl = entry.url;
  const sources = await getAllNetronlineSources(state, county).catch(() => []);
  const netr = sources
    .filter(s => s.onlineUrl && /apprais|assessor|\bcad\b/i.test(s.name) && !/netronline\.com/i.test(s.onlineUrl))
    .map(s => s.onlineUrl);
  const linked = (await Promise.all([currentUrl, entry.directoryUrl].filter(Boolean).map(homepageSearchLinks))).flat();
  const candidates = [
    ...(entry.override && entry.directoryUrl ? [entry.directoryUrl] : []),
    ...linked,
    ...netr,
  ].filter((u, i, a) => a.findIndex(x => sameUrl(x, u)) === i && !sameUrl(u, currentUrl) && !TAX_SITE.test(u)).slice(0, 4);

  const tried = [];
  let best = null, blockedAt = null;
  for (const url of candidates) {
    const health = await checkUrlHealth(url).catch(() => 'dead');
    if (health === 'dead') { tried.push({ url, result: 'dead' }); continue; }
    const p = await probeCounty(baseUrl, state, county, url);
    tried.push({ url, result: p.status, engine: p.engine, n: p.n || 0 });
    // The real search portal sits behind a CAPTCHA: the county is blocked, not broken
    if (p.status === 'captcha' && !blockedAt) blockedAt = { url, summary: p.summary };
    if (p.status !== 'ok') continue;
    if (!best || (best.p.engine === 'ai' && p.engine !== 'ai')) best = { url, p };
    if (p.engine !== 'ai') break;
  }
  if (!best && blockedAt) {
    // Point searches at the real portal so users get the CAPTCHA notice at once
    // instead of an AI fallback wandering the CAD's homepage
    store.setUrlOverride(state, county, {
      url: blockedAt.url, platform: detectFromUrl(blockedAt.url), previousUrl: currentUrl,
      verifiedAt: new Date().toISOString(), runId, blocked: true, sample: { note: blockedAt.summary },
    });
    console.log(`[agents] ${state}/${county}: search portal ${blockedAt.url} is CAPTCHA-protected`);
    return { repaired: false, blocked: true, url: blockedAt.url, tried };
  }
  if (!best) return { repaired: false, tried };

  if (entry.directoryUrl && sameUrl(best.url, entry.directoryUrl)) {
    store.setUrlOverride(state, county, null);   // original URL works again — drop the override
  } else {
    store.setUrlOverride(state, county, {
      url: best.url, platform: detectFromUrl(best.url), previousUrl: currentUrl,
      verifiedAt: new Date().toISOString(), runId,
      sample: { surname: best.p.surname, owner: best.p.owner, id: best.p.id, records: best.p.n, engine: best.p.engine },
    });
  }
  console.log(`[agents] ${state}/${county}: URL repaired → ${best.url}`);
  return { repaired: true, url: best.url, tried };
}

/**
 * Run the agent over a state's counties.
 * @param {object}   opts
 * @param {string}   opts.state         two-letter code
 * @param {string}   opts.baseUrl       app origin to probe, e.g. http://127.0.0.1:3000
 * @param {string[]} [opts.counties]    subset (default: whole state)
 * @param {number}   [opts.concurrency] parallel probes (default 2)
 * @param {number}   [opts.aiMax]       cap on LLM diagnoses per run
 * @param {boolean}  [opts.repair]      attempt URL repairs (default true)
 * @param {string}   [opts.trigger]     'schedule' | 'manual'
 */
async function runStateAgent({ state, baseUrl, counties, concurrency = 2, aiMax = 40, repair = true, trigger = 'manual', resume = null }) {
  state = state.toUpperCase();
  let run, list;
  if (resume) {
    // Continue a run cut off by a restart/deploy with the counties it hadn't reached
    run = resume;
    const all = run.countyList || getCountiesForState(state);
    list = all.filter(c => !run.counties[c]);
    run.resumedAt = [...(run.resumedAt || []), new Date().toISOString()];
  } else {
    list = counties && counties.length ? counties : getCountiesForState(state);
    run = {
      id: `${state}-${new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')}`,
      state, trigger, startedAt: new Date().toISOString(), finishedAt: null,
      partial: !!(counties && counties.length),
      countyList: list,
      total: list.length, counties: {}, summary: {}, regressions: [], repairs: [],
    };
  }
  const prev = run.previousRunId
    ? store.loadRun(run.previousRunId)
    : store.latestRun(state, { finishedOnly: true, fullOnly: true });
  run.previousRunId = prev ? prev.id : null;
  store.saveRun(run);
  console.log(`[agents] ${run.id}: ${resume ? 'resuming' : 'starting'} ${list.length} counties (${trigger})`);

  let next = 0, aiUsed = run.aiDiagnoses || 0;
  const worker = async () => {
    while (next < list.length) {
      const county = list[next++];
      const entry = getCountyUrl(state, county);
      const r = { county, url: entry.url, platform: entry.platform, overridden: !!entry.override };
      try {
        if (!entry.url) {
          Object.assign(r, { category: 'failing', probe: { status: 'error', summary: 'No URL in directory' } });
        } else {
          r.probe = await probeCounty(baseUrl, state, county);
          r.category = classify(r.probe);
          if (repair && (r.category === 'site_down' || r.category === 'failing')) {
            r.repair = await tryRepair(baseUrl, state, county, entry, run.id);
            if (r.repair.repaired) { r.category = 'repaired'; run.repairs.push({ county, url: r.repair.url, previousUrl: entry.url }); }
            else if (r.repair.blocked) r.category = 'blocked';
          }
          if (!GOOD.has(r.category) && !['blocked', 'repaired'].includes(r.category) && aiUsed < aiMax) {
            aiUsed++;
            r.diagnosis = await aiDiagnose({ state, county, platform: entry.platform, url: entry.url, probe: r.probe, category: r.category });
          }
          if (GOOD.has(r.category)) {
            store.setBaseline(state, county, { at: run.startedAt, surname: r.probe.surname, owner: r.probe.owner, id: r.probe.id, records: r.probe.n, engine: r.probe.engine });
          }
        }
      } catch (err) {
        Object.assign(r, { category: 'failing', error: err.message });
      }
      const before = prev && prev.counties[county];
      if (before && GOOD.has(before.category) && !GOOD.has(r.category) && r.category !== 'repaired') {
        r.regression = true;
        r.regressionFrom = before.category;
        run.regressions.push({ county, from: before.category, to: r.category });
      }
      run.counties[county] = r;
      run.summary[r.category] = (run.summary[r.category] || 0) + 1;
      run.done = Object.keys(run.counties).length;
      run.aiDiagnoses = aiUsed;
      store.saveRun(run);
      console.log(`[agents] ${state}/${county}: ${r.category} (${r.probe?.status || '-'}, ${r.probe?.secs ?? '-'}s)`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  run.finishedAt = new Date().toISOString();
  run.aiDiagnoses = aiUsed;
  store.saveRun(run);
  console.log(`[agents] ${run.id}: finished ${JSON.stringify(run.summary)}; ${run.regressions.length} regression(s), ${run.repairs.length} repair(s)`);
  return run;
}

module.exports = { runStateAgent, probe, homepageSearchLinks };
