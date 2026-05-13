'use strict';

require('dotenv').config();

// Crash on fatal startup errors; log-and-continue for runtime errors
process.on('uncaughtException', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌  Port ${err.port || process.env.PORT || 3000} is already in use.\n`);
    console.error('    Fix: open Task Manager → kill all node.exe processes, then re-run npm start\n');
    console.error('    Or run in a new terminal:  npx kill-port 3000\n');
    process.exit(1);
  }
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const axios   = require('axios');

const { runBrowserAgent }               = require('./browserAgent');
const { getAllStates, getCountiesForState, getCountyUrl } = require('./src/countyDirectory');
const { resolveCountyUrl, getAllNetronlineSources } = require('./src/urlHealthCheck');
const { detectFromUrl, platformLabel }  = require('./src/platformDetector');
const metrics = require('./src/metrics');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Docs routes — registered FIRST, before any middleware ───────────────────
// These must come before express.static('public') and the SPA catch-all.
app.get('/docs/ping', (_, res) => res.json({ ok: true, version: 'docs-fix-v3' }));
app.get('/docs/:file', (req, res, next) => {
  const abs = path.join(__dirname, 'docs', req.params.file);
  if (fs.existsSync(abs)) return res.sendFile(abs);
  next();
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── HTTP instrumentation middleware ─────────────────────────────────────────
app.use((req, res, next) => {
  const end = metrics.httpRequestDurationSeconds.startTimer();
  res.on('finish', () => {
    const route = req.route ? req.baseUrl + req.route.path : req.path;
    const labels = { method: req.method, route, status_code: res.statusCode };
    metrics.httpRequestsTotal.inc(labels);
    end(labels);
  });
  next();
});

// ─── Prometheus metrics endpoint ──────────────────────────────────────────────
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', metrics.register.contentType);
  res.end(await metrics.register.metrics());
});

// ─── Concurrency guard ────────────────────────────────────────────────────────
// Each search spawns a full Chromium process (~400–500 MB RAM).
// Cap simultaneous searches so the server doesn't OOM under load.
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SEARCHES || '5', 10);
let activeSearches = 0;

// Per-request hard timeout — prevents a stuck county site from holding a
// connection open indefinitely. Configurable via env for slow networks.
const SEARCH_TIMEOUT_MS = parseInt(process.env.SEARCH_TIMEOUT_MS || String(3 * 60 * 1000), 10);

// ─── Search result cache ───────────────────────────────────────────────────────
// In production, thousands of orders can search the same county/owner repeatedly.
// Caching avoids redundant Playwright launches and OpenAI API calls.
// Property records rarely change within a working day → 4-hour TTL is safe.
const CACHE_TTL_MS   = parseInt(process.env.CACHE_TTL_HOURS || '4', 10) * 60 * 60 * 1000;
const CACHE_MAX_SIZE = parseInt(process.env.CACHE_MAX_SIZE  || '1000', 10);

const _searchCache = new Map(); // cacheKey → { result, cachedAt, hits }

function _buildCacheKey({ url, firstName, lastName, fullName, accountNumber }) {
  return [url, firstName, lastName, fullName, accountNumber]
    .map(s => (s || '').trim().toLowerCase())
    .join('§');
}

function _cacheGet(key) {
  const entry = _searchCache.get(key);
  if (!entry) { metrics.cacheMissesTotal.inc(); return null; }
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) { _searchCache.delete(key); metrics.cacheMissesTotal.inc(); return null; }
  entry.hits++;
  metrics.cacheHitsTotal.inc();
  return entry.result;
}

function _cacheSet(key, result) {
  if (result.captchaBlocked) return; // transient block — don't cache
  if (_searchCache.size >= CACHE_MAX_SIZE) {
    _searchCache.delete(_searchCache.keys().next().value); // evict oldest (LRU-lite)
  }
  _searchCache.set(key, { result, cachedAt: Date.now(), hits: 0 });
  metrics.cacheSizeGauge.set(_searchCache.size);
  console.log(`[cache] stored key (size=${_searchCache.size}/${CACHE_MAX_SIZE})`);
}

function _getCacheStats() {
  let totalHits = 0, liveEntries = 0;
  const now = Date.now();
  for (const entry of _searchCache.values()) {
    if (now - entry.cachedAt <= CACHE_TTL_MS) { liveEntries++; totalHits += entry.hits; }
  }
  return { size: _searchCache.size, liveEntries, maxSize: CACHE_MAX_SIZE,
           ttlHours: CACHE_TTL_MS / 3_600_000, totalCacheHits: totalHits };
}

function runBrowserAgentWithTimeout(params) {
  return Promise.race([
    runBrowserAgent(params),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(
          `Search timed out after ${Math.round(SEARCH_TIMEOUT_MS / 60000)} minutes. ` +
          'The county website may be unresponsive — please try again.'
        )),
        SEARCH_TIMEOUT_MS
      )
    ),
  ]);
}

// ─── Directory endpoints ──────────────────────────────────────────────────────

// GET /api/states  → [{ code, name }, ...]
app.get('/api/states', (_req, res) => {
  res.json(getAllStates());
});

// GET /api/counties?state=TX  → ['Andrews', 'Bexar', ...]
app.get('/api/counties', (req, res) => {
  const { state } = req.query;
  if (!state) return res.status(400).json({ error: 'state query param required' });
  res.json(getCountiesForState(state));
});

// GET /api/county-url?state=TX&county=Andrews
// Returns the stored URL, checks health, refreshes from netronline if dead.
app.get('/api/county-url', async (req, res) => {
  const { state, county } = req.query;
  if (!state || !county) return res.status(400).json({ error: 'state and county required' });

  const lookup = getCountyUrl(state, county);

  if (!lookup.url) {
    return res.json({ url: null, platform: 'unknown', status: 'not_found',
      message: `No URL found for ${county}, ${state}. Try entering the URL manually.` });
  }

  // Quick health check + auto-refresh if dead
  const resolved = await resolveCountyUrl(lookup.url, state, county);
  const platform = detectFromUrl(resolved.url);

  return res.json({
    url:           resolved.url,
    platform,
    platformLabel: platformLabel(platform),
    status:        resolved.status,   // 'alive' | 'refreshed' | 'dead'
    message:       resolved.message,
  });
});

// ─── ZIP code → state + county lookup ────────────────────────────────────────

// GET /api/zip-lookup?zip=75751
// Returns { state: "TX", county: "Henderson", city: "Athens" }
// Two-step: zippopotam.us → state + coordinates, then FCC Census Block API → county
app.get('/api/zip-lookup', async (req, res) => {
  const zip = (req.query.zip || '').trim();
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'Valid 5-digit ZIP code required' });
  }

  try {
    // Step 1: ZIP → state abbreviation + centroid coordinates
    const zipRes = await axios.get(`https://api.zippopotam.us/us/${zip}`, { timeout: 8000 });
    const place  = zipRes.data?.places?.[0];
    if (!place) {
      return res.status(404).json({ error: `No location found for ZIP ${zip}` });
    }
    const stateCode = place['state abbreviation'];
    if (!stateCode) {
      return res.status(404).json({ error: `Could not determine state for ZIP ${zip}` });
    }
    const lat  = parseFloat(place.latitude);
    const lon  = parseFloat(place.longitude);
    const city = place['place name'] || '';

    // Step 2: centroid → county via FCC Census Block finder
    const fccRes = await axios.get(
      `https://geo.fcc.gov/api/census/block/find?latitude=${lat}&longitude=${lon}&format=json`,
      { timeout: 8000 }
    );
    const countyRaw  = fccRes.data?.County?.name || '';
    const countyName = countyRaw.replace(/\s+County$/i, '').trim();
    if (!countyName) {
      return res.status(404).json({ error: `Could not determine county for ZIP ${zip}` });
    }

    return res.json({ state: stateCode, county: countyName, city });
  } catch (err) {
    console.error('[zip-lookup]', err.message);
    return res.status(500).json({ error: 'ZIP lookup failed — please select state and county manually.' });
  }
});

// GET /api/county-sources?state=TX&county=Anderson
// Returns all data-source rows scraped from publicrecords.netronline.com for the county.
app.get('/api/county-sources', async (req, res) => {
  const { state, county } = req.query;
  if (!state || !county) return res.status(400).json({ error: 'state and county required' });

  try {
    const sources = await getAllNetronlineSources(state, county);
    return res.json({ sources });
  } catch (err) {
    console.error('[county-sources]', err.message);
    return res.status(500).json({ sources: [] });
  }
});

// ─── Source-type classifier (for NETR sources) ────────────────────────────────

function classifyNetronlineSource(name, url) {
  const n = (name || '').toLowerCase();
  const u = (url  || '').toLowerCase();
  if (n.includes('mapping') || n.includes('gis') || u.includes('/gis') || u.includes('maps.'))
    return 'skip';
  if (n.includes('aerial') || u.includes('historicaerials.com') || u.includes('aerials.com'))
    return 'link';
  if (n.includes('appraisal') || n.includes('assessor') || n.includes('appraiser') ||
      n.includes(' cad') || n.startsWith('cad '))
    return 'appraisal';
  if (n.includes('tax') || n.includes('treasurer') || n.includes('collector'))
    return 'tax';
  if (n.includes('clerk') || n.includes('recorder') || n.includes('deed') ||
      n.includes('court') || n.includes('probate') || n.includes('register'))
    return 'clerk';
  return 'search';
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'mortgage-search-service',
    timestamp: new Date().toISOString(),
    activeSearches,
    maxConcurrent: MAX_CONCURRENT,
    cache: _getCacheStats(),
  });
});

// ─── SSE Search Endpoint ──────────────────────────────────────────────────────

app.get('/api/search/stream', async (req, res) => {
  const { url, state, county, firstName, lastName, fullName, accountNumber } = req.query;

  // Resolve URL: explicit url param > state+county lookup
  let searchUrl = url || '';
  let urlStatus = 'manual';

  if (!searchUrl && state && county) {
    const lookup = getCountyUrl(state, county);
    if (lookup.url) {
      searchUrl = lookup.url;
      urlStatus = 'directory';
    }
  }

  if (!searchUrl) {
    return res.status(400).json({ error: 'Provide url or state+county parameters' });
  }

  // ── Concurrency check — reject before opening SSE stream ─────────────────
  if (activeSearches >= MAX_CONCURRENT) {
    metrics.concurrencyRejectedTotal.inc();
    return res.status(503).json({
      error: `Server busy — ${activeSearches} searches already running (max ${MAX_CONCURRENT}). Please try again in a moment.`,
    });
  }

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => clearInterval(heartbeat));

  activeSearches++;
  metrics.activeSearchesGauge.set(activeSearches);
  console.log(`[server] search started — active: ${activeSearches}/${MAX_CONCURRENT}`);

  const searchTimer = metrics.searchDurationSeconds.startTimer({ endpoint: 'stream' });

  try {
    sendEvent('status', { message: 'Starting search...' });

    // URL health check (only for directory-sourced URLs, skip for manual)
    if (urlStatus === 'directory' && state && county) {
      sendEvent('progress', { message: 'Verifying county URL...' });
      const resolved = await resolveCountyUrl(searchUrl, state, county);
      searchUrl = resolved.url;
      if (resolved.status === 'refreshed') {
        sendEvent('progress', { message: `County URL updated: ${resolved.message}` });
      } else if (resolved.status === 'dead') {
        sendEvent('progress', { message: `Warning: ${resolved.message}` });
      }
    }

    // ── Cache check ────────────────────────────────────────────────────────────
    const cacheParams = { url: searchUrl,
      firstName: firstName || '', lastName: lastName || '',
      fullName: fullName || '', accountNumber: accountNumber || '' };
    const cacheKey    = _buildCacheKey(cacheParams);
    const cached      = _cacheGet(cacheKey);

    if (cached) {
      console.log(`[cache] HIT — serving stored results (hits=${_searchCache.get(cacheKey)?.hits})`);
      sendEvent('progress', { message: '⚡ Cache hit — returning stored results instantly (no browser needed)' });
      if (cached.captchaBlocked) {
        sendEvent('captcha', { type: cached.captchaType || 'CAPTCHA', message: cached.summary, searchedUrl: cached.searchedUrl });
      }
      sendEvent('results', { ...cached, fromCache: true });
      sendEvent('done', { success: true, fromCache: true });
      return;
    }

    sendEvent('progress', { message: `Using: ${searchUrl}` });

    const results = await runBrowserAgentWithTimeout({
      url: searchUrl,
      firstName:     firstName     || '',
      lastName:      lastName      || '',
      fullName:      fullName      || '',
      accountNumber: accountNumber || '',
      onProgress:    (message) => sendEvent('progress', { message }),
    });

    _cacheSet(cacheKey, results); // store for future identical searches

    if (results.captchaBlocked) {
      metrics.searchesTotal.inc({ endpoint: 'stream', status: 'captcha' });
      sendEvent('captcha', {
        type:        results.captchaType || 'CAPTCHA',
        message:     results.summary,
        searchedUrl: results.searchedUrl,
      });
    } else {
      metrics.searchesTotal.inc({ endpoint: 'stream', status: 'success' });
    }
    sendEvent('results', results);
    sendEvent('done', { success: true });
  } catch (err) {
    console.error('[server] Search error:', err.message);
    const status = err.message.includes('timed out') ? 'timeout' : 'error';
    metrics.searchesTotal.inc({ endpoint: 'stream', status });
    sendEvent('error', { message: err.message || 'An unexpected error occurred' });
  } finally {
    searchTimer();
    activeSearches--;
    metrics.activeSearchesGauge.set(activeSearches);
    console.log(`[server] search finished — active: ${activeSearches}/${MAX_CONCURRENT}`);
    clearInterval(heartbeat);
    res.end();
  }
});

// ─── Dual Search (Appraisal + Tax Office) — Anderson County TX Phase 1 ────────
//
// Runs two parallel browser searches:
//   1. Appraisal data  → andersoncad.net     (Public Portal / Aumentum)
//   2. Tax bill data   → tax.co.anderson.tx.us (Anderson County Tax Office)
//
// Emits separate SSE events: appraisalResults + taxResults, then done.
// Progress from each search is tagged [Appraisal] / [Tax] in the log.
//
// Phase 1: Anderson County, TX only.  Property ID required.
// Future: generalise to any county that has both a CAD URL and a Tax URL.

app.get('/api/search/dual/stream', async (req, res) => {
  const { accountNumber, firstName, lastName, fullName } = req.query;

  if (!accountNumber && !firstName && !lastName && !fullName) {
    return res.status(400).json({ error: 'Provide accountNumber (Property ID) or owner name.' });
  }

  // Dual search counts as 2 concurrent browser instances
  if (activeSearches + 2 > MAX_CONCURRENT) {
    metrics.concurrencyRejectedTotal.inc();
    return res.status(503).json({
      error: `Server busy — ${activeSearches} searches running (max ${MAX_CONCURRENT}). Please try again shortly.`,
    });
  }

  // ── SSE setup ────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => clearInterval(heartbeat));

  const APPRAISAL_URL = 'https://andersoncad.net';
  const TAX_URL       = 'http://tax.co.anderson.tx.us';

  activeSearches += 2;
  metrics.activeSearchesGauge.set(activeSearches);
  console.log(`[server] dual search started — active: ${activeSearches}/${MAX_CONCURRENT}`);

  // CAD uses numeric IDs (60110); Tax Office uses "R" prefix (R60110).
  // Strip the prefix for the appraisal search so the full-text API matches correctly.
  const cadAccountNumber = (accountNumber || '').replace(/^[rR]/, '');

  const commonParams = { firstName: firstName || '', lastName: lastName || '', fullName: fullName || '' };

  const dualTimer = metrics.searchDurationSeconds.startTimer({ endpoint: 'dual' });

  try {
    sendEvent('status', { message: 'Starting dual search: Appraisal (CAD) + Tax Office...' });

    const [appraisalResult, taxResult] = await Promise.all([
      runBrowserAgentWithTimeout({
        url: APPRAISAL_URL,
        ...commonParams,
        accountNumber: cadAccountNumber,
        onProgress: (msg) => sendEvent('progress', { message: `[Appraisal] ${msg}`, source: 'appraisal' }),
      }).catch(err => ({
        records: [], totalFound: 0,
        summary: `Appraisal search error: ${err.message}`,
        searchedUrl: APPRAISAL_URL,
        error: err.message,
      })),

      runBrowserAgentWithTimeout({
        url: TAX_URL,
        ...commonParams,
        accountNumber: accountNumber || '',
        onProgress: (msg) => sendEvent('progress', { message: `[Tax] ${msg}`, source: 'tax' }),
      }).catch(err => ({
        records: [], totalFound: 0,
        summary: `Tax search error: ${err.message}`,
        searchedUrl: TAX_URL,
        error: err.message,
      })),
    ]);

    const hadError = appraisalResult.error || taxResult.error;
    metrics.searchesTotal.inc({ endpoint: 'dual', status: hadError ? 'error' : 'success' });

    sendEvent('appraisalResults', appraisalResult);
    sendEvent('taxResults',       taxResult);
    sendEvent('done', { success: true, isDual: true });
  } catch (err) {
    console.error('[server] dual search error:', err.message);
    metrics.searchesTotal.inc({ endpoint: 'dual', status: 'error' });
    sendEvent('error', { message: err.message || 'Unexpected error during dual search' });
  } finally {
    dualTimer();
    activeSearches -= 2;
    metrics.activeSearchesGauge.set(activeSearches);
    console.log(`[server] dual search finished — active: ${activeSearches}/${MAX_CONCURRENT}`);
    clearInterval(heartbeat);
    res.end();
  }
});

// ─── Multi-Source Search (All NETR sources for a county) ─────────────────────
//
// For account-number searches: searches ALL non-GIS/non-aerial NETR sources in
// parallel.  For name-only searches: searches the appraisal (CAD) source only.
//
// Emits SSE events: sources | source_progress | source_result |
//                   source_link | source_error | done

app.get('/api/search/multi/stream', async (req, res) => {
  const { state, county, firstName, lastName, fullName, accountNumber } = req.query;

  if (!state || !county) {
    return res.status(400).json({ error: 'state and county are required' });
  }
  if (!firstName && !lastName && !fullName && !accountNumber) {
    return res.status(400).json({ error: 'Provide a name or account number to search' });
  }

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => clearInterval(heartbeat));

  const multiTimer = metrics.searchDurationSeconds.startTimer({ endpoint: 'multi' });
  let startedCount = 0;

  try {
    sendEvent('status', { message: `Loading county sources for ${county}, ${state}...` });

    const [netronlineSources, countyUrlInfo] = await Promise.all([
      getAllNetronlineSources(state, county).catch(() => []),
      Promise.resolve(getCountyUrl(state, county)),
    ]);

    // Build a de-duplicated source list
    const seen = new Set();
    const allSources = [];

    if (countyUrlInfo.url) {
      const key = countyUrlInfo.url.replace(/\/$/, '').toLowerCase();
      seen.add(key);
      allSources.push({
        id: 'appraisal_dir',
        name: 'Appraisal (CAD)',
        type: 'appraisal',
        url: countyUrlInfo.url,
        linkOnly: false,
      });
    }

    for (const src of netronlineSources) {
      if (!src.onlineUrl) continue;
      const type = classifyNetronlineSource(src.name, src.onlineUrl);
      if (type === 'skip') continue;
      const key = src.onlineUrl.replace(/\/$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      allSources.push({
        id: src.name.toLowerCase().replace(/\W+/g, '_').replace(/_+/g, '_'),
        name: src.name,
        type,
        url: src.onlineUrl,
        linkOnly: type === 'link',
      });
    }

    // Name-only → appraisal only; account number → all searchable sources
    const isNameSearch = !accountNumber;
    const searchable = isNameSearch
      ? allSources.filter(s => !s.linkOnly && s.type === 'appraisal')
      : allSources.filter(s => !s.linkOnly);
    const linkSources = allSources.filter(s => s.linkOnly);

    sendEvent('sources', { sources: allSources, searchMode: isNameSearch ? 'name' : 'account' });

    for (const src of linkSources) {
      sendEvent('source_link', { id: src.id, name: src.name, url: src.url });
    }

    if (searchable.length === 0) {
      sendEvent('done', { success: true, isMulti: true });
      return;
    }

    // Cap at 4 concurrent browser instances
    const toSearch = searchable.slice(0, 4);

    if (activeSearches + toSearch.length > MAX_CONCURRENT + 2) {
      metrics.concurrencyRejectedTotal.inc();
      sendEvent('error', { message: `Server busy — ${activeSearches} searches running. Try again in a moment.` });
      return;
    }

    startedCount = toSearch.length;
    activeSearches += startedCount;
    metrics.activeSearchesGauge.set(activeSearches);
    console.log(`[server] multi search started (${startedCount} sources) — active: ${activeSearches}/${MAX_CONCURRENT}`);

    const commonParams = {
      firstName:     firstName     || '',
      lastName:      lastName      || '',
      fullName:      fullName      || '',
      accountNumber: accountNumber || '',
    };

    await Promise.allSettled(toSearch.map(async (src) => {
      sendEvent('source_progress', { id: src.id, message: `Starting search at ${src.name}...` });
      try {
        const result = await runBrowserAgentWithTimeout({
          url: src.url,
          ...commonParams,
          onProgress: (msg) => sendEvent('source_progress', { id: src.id, message: msg }),
        });
        sendEvent('source_result', {
          id: src.id, name: src.name, type: src.type, url: src.url, ...result,
        });
        metrics.searchesTotal.inc({ endpoint: 'multi', status: result.error ? 'error' : 'success' });
      } catch (err) {
        sendEvent('source_error', { id: src.id, name: src.name, message: err.message });
        metrics.searchesTotal.inc({ endpoint: 'multi', status: 'error' });
      }
    }));

    sendEvent('done', { success: true, isMulti: true });
  } catch (err) {
    console.error('[server] multi search error:', err.message);
    metrics.searchesTotal.inc({ endpoint: 'multi', status: 'error' });
    sendEvent('error', { message: err.message || 'Unexpected error during multi-source search' });
  } finally {
    multiTimer();
    if (startedCount > 0) {
      activeSearches -= startedCount;
      metrics.activeSearchesGauge.set(activeSearches);
    }
    console.log(`[server] multi search finished — active: ${activeSearches}/${MAX_CONCURRENT}`);
    clearInterval(heartbeat);
    res.end();
  }
});

// ─── REST fallback ────────────────────────────────────────────────────────────

app.post('/api/search', async (req, res) => {
  const { url, firstName, lastName, fullName, accountNumber } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  if (activeSearches >= MAX_CONCURRENT) {
    metrics.concurrencyRejectedTotal.inc();
    return res.status(503).json({
      success: false,
      error: `Server busy — ${activeSearches} searches already running (max ${MAX_CONCURRENT}). Please try again in a moment.`,
    });
  }

  activeSearches++;
  metrics.activeSearchesGauge.set(activeSearches);
  console.log(`[server] REST search started — active: ${activeSearches}/${MAX_CONCURRENT}`);

  try {
    const cacheKey = _buildCacheKey({ url,
      firstName: firstName || '', lastName: lastName || '',
      fullName: fullName || '', accountNumber: accountNumber || '' });
    const cached = _cacheGet(cacheKey);

    if (cached) {
      console.log(`[cache] REST HIT`);
      if (cached.captchaBlocked) {
        return res.status(422).json({ success: false, captchaBlocked: true,
          captchaType: cached.captchaType || 'CAPTCHA', error: cached.summary,
          results: cached, fromCache: true });
      }
      return res.json({ success: true, results: cached, fromCache: true });
    }

    const results = await runBrowserAgentWithTimeout({
      url,
      firstName:     firstName     || '',
      lastName:      lastName      || '',
      fullName:      fullName      || '',
      accountNumber: accountNumber || '',
    });

    _cacheSet(cacheKey, results);

    if (results.captchaBlocked) {
      metrics.searchesTotal.inc({ endpoint: 'rest', status: 'captcha' });
      return res.status(422).json({
        success: false,
        captchaBlocked: true,
        captchaType:    results.captchaType || 'CAPTCHA',
        error:          results.summary,
        results,
      });
    }

    metrics.searchesTotal.inc({ endpoint: 'rest', status: 'success' });
    res.json({ success: true, results });
  } catch (err) {
    console.error('[server] REST search error:', err.message);
    const isTimeout = err.message.includes('timed out');
    metrics.searchesTotal.inc({ endpoint: 'rest', status: isTimeout ? 'timeout' : 'error' });
    res.status(isTimeout ? 504 : 500).json({ success: false, error: err.message });
  } finally {
    activeSearches--;
    metrics.activeSearchesGauge.set(activeSearches);
    console.log(`[server] REST search finished — active: ${activeSearches}/${MAX_CONCURRENT}`);
  }
});

// ─── Serve docs (explicit fallback for any /docs/* request) ──────────────────

app.get('/docs/*', (req, res, next) => {
  const rel = req.path.replace(/^\/docs\//, '');
  const abs = path.resolve(path.join(__dirname, 'docs'), rel);
  if (!abs.startsWith(path.join(__dirname, 'docs'))) return next();
  res.sendFile(abs, err => { if (err && !res.headersSent) next(); });
});

// ─── Serve frontend ───────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  // Serve /docs/* from the docs folder before falling back to the SPA
  if (req.path.startsWith('/docs/')) {
    const rel = path.basename(req.path); // strip any directory traversal
    const abs = path.join(__dirname, 'docs', req.path.replace(/^\/docs\//, ''));
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return res.sendFile(abs);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🏠 Mortgage Title & Tax Search Service`);
  console.log(`   Running at:  http://localhost:${PORT}`);
  console.log(`   Health:      http://localhost:${PORT}/api/health`);
  console.log(`   Concurrency: max ${MAX_CONCURRENT} simultaneous searches`);
  console.log(`   Timeout:     ${Math.round(SEARCH_TIMEOUT_MS / 60000)} min per search`);
  console.log(`   Counties DB: ${require('fs').existsSync('./data/counties.json') ? '✅ loaded' : '⚠️  not built yet — run: node scripts/buildCountyDirectory.js'}\n`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌  Port ${PORT} is already in use by another process.\n`);
    console.error('    Run this in a new PowerShell window to free it:\n');
    console.error(`        Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force\n`);
    console.error('    Then run npm start again.\n');
  } else {
    console.error('Server listen error:', err);
  }
  process.exit(1);
});
