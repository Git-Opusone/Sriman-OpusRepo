'use strict';

const express = require('express');
const router  = express.Router();

const { runBrowserAgent }                             = require('./browser');
const { resolveCountyUrl, getAllNetronlineSources }    = require('../shared/urlHealthCheck');
const { getCountyUrl }                                = require('../shared/countyDirectory');
const metrics                                         = require('../shared/metrics');

// ─── Concurrency guard ────────────────────────────────────────────────────────
const MAX_CONCURRENT    = parseInt(process.env.MAX_CONCURRENT_SEARCHES || '5', 10);
const SEARCH_TIMEOUT_MS = parseInt(process.env.SEARCH_TIMEOUT_MS || String(3 * 60 * 1000), 10);
let activeSearches = 0;

// ─── Search result cache ───────────────────────────────────────────────────────
const CACHE_TTL_MS   = parseInt(process.env.CACHE_TTL_HOURS || '4', 10) * 60 * 60 * 1000;
const CACHE_MAX_SIZE = parseInt(process.env.CACHE_MAX_SIZE  || '1000', 10);
const _searchCache   = new Map();

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
  if (result.captchaBlocked) return;
  if (_searchCache.size >= CACHE_MAX_SIZE) {
    _searchCache.delete(_searchCache.keys().next().value);
  }
  _searchCache.set(key, { result, cachedAt: Date.now(), hits: 0 });
  metrics.cacheSizeGauge.set(_searchCache.size);
  console.log(`[tax-cache] stored key (size=${_searchCache.size}/${CACHE_MAX_SIZE})`);
}

function getCacheStats() {
  let totalHits = 0, liveEntries = 0;
  const now = Date.now();
  for (const entry of _searchCache.values()) {
    if (now - entry.cachedAt <= CACHE_TTL_MS) { liveEntries++; totalHits += entry.hits; }
  }
  return { size: _searchCache.size, liveEntries, maxSize: CACHE_MAX_SIZE,
           ttlHours: CACHE_TTL_MS / 3_600_000, totalCacheHits: totalHits };
}

function getActiveSearches() { return activeSearches; }

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

/**
 * Extracts the best account/parcel ID from a CAD search result to use when
 * searching the Tax Office. The CAD result normalises the ID (e.g. adds/removes
 * "R" prefix, zero-pads) so using it avoids format-mismatch failures.
 *
 * Priority: records[0].parcelId → additionalDetails account fields → original ID
 */
function extractTaxAccountId(cadResult, originalId) {
  try {
    if (!cadResult || !cadResult.records || !cadResult.records.length) return originalId;
    const rec = cadResult.records[0];

    // Direct parcelId on the record
    if (rec.parcelId && rec.parcelId.trim() && !/motor\s*vehicle|renewal/i.test(rec.parcelId)) {
      return rec.parcelId.trim();
    }

    // Parse additionalDetails for account number fields
    if (rec.additionalDetails) {
      let details = rec.additionalDetails;
      if (typeof details === 'string') {
        try { details = JSON.parse(details); } catch (_) { details = {}; }
      }
      const ACCT_KEYS = [
        'Account Number', 'Account No', 'Account', 'Account #', 'Acct',
        'Property ID', 'Parcel ID', 'Parcel Number', 'Tax Account', 'CAD ID',
        'account number', 'account no', 'property id', 'parcel id',
      ];
      for (const key of ACCT_KEYS) {
        const val = details[key];
        if (val && typeof val === 'string' && val.trim() && !/motor\s*vehicle/i.test(val)) {
          return val.trim();
        }
      }
    }
  } catch (_) {}
  return originalId;
}

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

// ─── SSE Search Endpoint ──────────────────────────────────────────────────────
// GET /api/tax/search/stream
router.get('/search/stream', async (req, res) => {
  const { url, state, county, firstName, lastName, fullName, accountNumber } = req.query;

  let searchUrl = url || '';
  let urlStatus = 'manual';

  if (!searchUrl && state && county) {
    const lookup = getCountyUrl(state, county);
    if (lookup.url) { searchUrl = lookup.url; urlStatus = 'directory'; }
  }

  if (!searchUrl) {
    return res.status(400).json({ error: 'Provide url or state+county parameters' });
  }

  if (activeSearches >= MAX_CONCURRENT) {
    metrics.concurrencyRejectedTotal.inc();
    return res.status(503).json({
      error: `Server busy — ${activeSearches} searches already running (max ${MAX_CONCURRENT}). Please try again in a moment.`,
    });
  }

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
  console.log(`[tax] search started — active: ${activeSearches}/${MAX_CONCURRENT}`);

  const searchTimer = metrics.searchDurationSeconds.startTimer({ endpoint: 'stream' });

  try {
    sendEvent('status', { message: 'Starting search...' });

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

    const cacheParams = { url: searchUrl,
      firstName: firstName || '', lastName: lastName || '',
      fullName: fullName || '', accountNumber: accountNumber || '' };
    const cacheKey = _buildCacheKey(cacheParams);
    const cached   = _cacheGet(cacheKey);

    if (cached) {
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
      firstName: firstName || '', lastName: lastName || '',
      fullName: fullName || '', accountNumber: accountNumber || '',
      onProgress: (message) => sendEvent('progress', { message }),
    });

    _cacheSet(cacheKey, results);

    if (results.captchaBlocked) {
      metrics.searchesTotal.inc({ endpoint: 'stream', status: 'captcha' });
      sendEvent('captcha', { type: results.captchaType || 'CAPTCHA', message: results.summary, searchedUrl: results.searchedUrl });
    } else {
      metrics.searchesTotal.inc({ endpoint: 'stream', status: 'success' });
    }
    sendEvent('results', results);
    sendEvent('done', { success: true });
  } catch (err) {
    console.error('[tax] Search error:', err.message);
    const status = err.message.includes('timed out') ? 'timeout' : 'error';
    metrics.searchesTotal.inc({ endpoint: 'stream', status });
    sendEvent('error', { message: err.message || 'An unexpected error occurred' });
  } finally {
    searchTimer();
    activeSearches--;
    metrics.activeSearchesGauge.set(activeSearches);
    console.log(`[tax] search finished — active: ${activeSearches}/${MAX_CONCURRENT}`);
    clearInterval(heartbeat);
    res.end();
  }
});

// ─── Dual Search (Appraisal + Tax Office) ────────────────────────────────────
// GET /api/tax/search/dual/stream
router.get('/search/dual/stream', async (req, res) => {
  const { accountNumber, firstName, lastName, fullName } = req.query;

  if (!accountNumber && !firstName && !lastName && !fullName) {
    return res.status(400).json({ error: 'Provide accountNumber (Property ID) or owner name.' });
  }

  if (activeSearches + 2 > MAX_CONCURRENT) {
    metrics.concurrencyRejectedTotal.inc();
    return res.status(503).json({
      error: `Server busy — ${activeSearches} searches running (max ${MAX_CONCURRENT}). Please try again shortly.`,
    });
  }

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
  console.log(`[tax] dual search started — active: ${activeSearches}/${MAX_CONCURRENT}`);

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
    console.error('[tax] dual search error:', err.message);
    metrics.searchesTotal.inc({ endpoint: 'dual', status: 'error' });
    sendEvent('error', { message: err.message || 'Unexpected error during dual search' });
  } finally {
    dualTimer();
    activeSearches -= 2;
    metrics.activeSearchesGauge.set(activeSearches);
    console.log(`[tax] dual search finished — active: ${activeSearches}/${MAX_CONCURRENT}`);
    clearInterval(heartbeat);
    res.end();
  }
});

// ─── Multi-Source Search ──────────────────────────────────────────────────────
// GET /api/tax/search/multi/stream
router.get('/search/multi/stream', async (req, res) => {
  const { state, county, firstName, lastName, fullName, accountNumber } = req.query;

  if (!state || !county) {
    return res.status(400).json({ error: 'state and county are required' });
  }
  if (!firstName && !lastName && !fullName && !accountNumber) {
    return res.status(400).json({ error: 'Provide a name or account number to search' });
  }

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

    const seen = new Set();
    const allSources = [];

    if (countyUrlInfo.url) {
      const key = countyUrlInfo.url.replace(/\/$/, '').toLowerCase();
      seen.add(key);
      allSources.push({ id: 'appraisal_dir', name: 'Appraisal (CAD)', type: 'appraisal',
                        url: countyUrlInfo.url, linkOnly: false });
    }

    if (countyUrlInfo.taxUrl) {
      const key = countyUrlInfo.taxUrl.replace(/\/$/, '').toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        allSources.push({ id: 'tax_office_dir', name: 'Tax Assessor-Collector Office', type: 'tax',
                          url: countyUrlInfo.taxUrl, linkOnly: false });
      }
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
        name: src.name, type, url: src.onlineUrl, linkOnly: type === 'link',
      });
    }

    const isNameSearch = !accountNumber;
    const searchable = isNameSearch
      ? allSources.filter(s => !s.linkOnly && (s.type === 'appraisal' || s.type === 'tax'))
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

    const toSearch = searchable.slice(0, 4);

    if (activeSearches + toSearch.length > MAX_CONCURRENT + 2) {
      metrics.concurrencyRejectedTotal.inc();
      sendEvent('error', { message: `Server busy — ${activeSearches} searches running. Try again in a moment.` });
      return;
    }

    startedCount = toSearch.length;
    activeSearches += startedCount;
    metrics.activeSearchesGauge.set(activeSearches);
    console.log(`[tax] multi search started (${startedCount} sources) — active: ${activeSearches}/${MAX_CONCURRENT}`);

    const baseParams = {
      firstName: firstName || '', lastName: lastName || '',
      fullName: fullName || '', accountNumber: accountNumber || '',
    };

    // ── Sequential CAD→TaxOffice strategy ────────────────────────────────────
    // Run the appraisal (CAD) source first. Extract the real account number from
    // its result (the CAD normalises IDs, e.g. strips "R" prefix, zero-pads).
    // Pass that normalised ID to the Tax Office so it finds the same property
    // even when the order's raw ID format differs from the tax office's format.

    const cadSrc   = toSearch.find(s => s.type === 'appraisal');
    const taxSrc   = toSearch.find(s => s.type === 'tax');
    const otherSrc = toSearch.filter(s => s.type !== 'appraisal' && s.type !== 'tax');

    let cadAccountNumber = accountNumber || '';  // best account ID discovered from CAD

    // Run CAD source first (if present)
    if (cadSrc) {
      sendEvent('source_progress', { id: cadSrc.id, message: `Starting search at ${cadSrc.name}...` });
      try {
        const cadResult = await runBrowserAgentWithTimeout({
          url: cadSrc.url, ...baseParams,
          onProgress: (msg) => sendEvent('source_progress', { id: cadSrc.id, message: msg }),
        });
        sendEvent('source_result', { id: cadSrc.id, name: cadSrc.name, type: cadSrc.type, url: cadSrc.url, ...cadResult });
        metrics.searchesTotal.inc({ endpoint: 'multi', status: cadResult.error ? 'error' : 'success' });

        // Extract the best account number from the CAD result to use for the Tax Office search
        cadAccountNumber = extractTaxAccountId(cadResult, accountNumber || '');
        if (cadAccountNumber !== (accountNumber || '')) {
          console.log(`[tax] CAD account ID resolved: "${accountNumber}" → "${cadAccountNumber}"`);
          sendEvent('status', { message: `Using account ID "${cadAccountNumber}" for Tax Office search...` });
        }
      } catch (err) {
        sendEvent('source_error', { id: cadSrc.id, name: cadSrc.name, message: err.message });
        metrics.searchesTotal.inc({ endpoint: 'multi', status: 'error' });
      }
    }

    // Run Tax Office source with the resolved account number
    if (taxSrc) {
      const taxParams = { ...baseParams, accountNumber: cadAccountNumber };
      sendEvent('source_progress', { id: taxSrc.id, message: `Starting search at ${taxSrc.name}...` });
      try {
        const taxResult = await runBrowserAgentWithTimeout({
          url: taxSrc.url, ...taxParams,
          onProgress: (msg) => sendEvent('source_progress', { id: taxSrc.id, message: msg }),
        });
        sendEvent('source_result', { id: taxSrc.id, name: taxSrc.name, type: taxSrc.type, url: taxSrc.url, ...taxResult });
        metrics.searchesTotal.inc({ endpoint: 'multi', status: taxResult.error ? 'error' : 'success' });
      } catch (err) {
        sendEvent('source_error', { id: taxSrc.id, name: taxSrc.name, message: err.message });
        metrics.searchesTotal.inc({ endpoint: 'multi', status: 'error' });
      }
    }

    // Run any remaining sources (netronline links, extra sources) in parallel
    await Promise.allSettled(otherSrc.map(async (src) => {
      sendEvent('source_progress', { id: src.id, message: `Starting search at ${src.name}...` });
      try {
        const result = await runBrowserAgentWithTimeout({
          url: src.url, ...baseParams,
          onProgress: (msg) => sendEvent('source_progress', { id: src.id, message: msg }),
        });
        sendEvent('source_result', { id: src.id, name: src.name, type: src.type, url: src.url, ...result });
        metrics.searchesTotal.inc({ endpoint: 'multi', status: result.error ? 'error' : 'success' });
      } catch (err) {
        sendEvent('source_error', { id: src.id, name: src.name, message: err.message });
        metrics.searchesTotal.inc({ endpoint: 'multi', status: 'error' });
      }
    }));

    sendEvent('done', { success: true, isMulti: true });
  } catch (err) {
    console.error('[tax] multi search error:', err.message);
    metrics.searchesTotal.inc({ endpoint: 'multi', status: 'error' });
    sendEvent('error', { message: err.message || 'Unexpected error during multi-source search' });
  } finally {
    multiTimer();
    if (startedCount > 0) {
      activeSearches -= startedCount;
      metrics.activeSearchesGauge.set(activeSearches);
    }
    console.log(`[tax] multi search finished — active: ${activeSearches}/${MAX_CONCURRENT}`);
    clearInterval(heartbeat);
    res.end();
  }
});

// ─── REST fallback ────────────────────────────────────────────────────────────
// POST /api/tax/search
router.post('/search', async (req, res) => {
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
  console.log(`[tax] REST search started — active: ${activeSearches}/${MAX_CONCURRENT}`);

  try {
    const cacheKey = _buildCacheKey({ url,
      firstName: firstName || '', lastName: lastName || '',
      fullName: fullName || '', accountNumber: accountNumber || '' });
    const cached = _cacheGet(cacheKey);

    if (cached) {
      if (cached.captchaBlocked) {
        return res.status(422).json({ success: false, captchaBlocked: true,
          captchaType: cached.captchaType || 'CAPTCHA', error: cached.summary,
          results: cached, fromCache: true });
      }
      return res.json({ success: true, results: cached, fromCache: true });
    }

    const results = await runBrowserAgentWithTimeout({
      url,
      firstName: firstName || '', lastName: lastName || '',
      fullName: fullName || '', accountNumber: accountNumber || '',
    });

    _cacheSet(cacheKey, results);

    if (results.captchaBlocked) {
      metrics.searchesTotal.inc({ endpoint: 'rest', status: 'captcha' });
      return res.status(422).json({
        success: false, captchaBlocked: true,
        captchaType: results.captchaType || 'CAPTCHA',
        error: results.summary, results,
      });
    }

    metrics.searchesTotal.inc({ endpoint: 'rest', status: 'success' });
    res.json({ success: true, results });
  } catch (err) {
    console.error('[tax] REST search error:', err.message);
    const isTimeout = err.message.includes('timed out');
    metrics.searchesTotal.inc({ endpoint: 'rest', status: isTimeout ? 'timeout' : 'error' });
    res.status(isTimeout ? 504 : 500).json({ success: false, error: err.message });
  } finally {
    activeSearches--;
    metrics.activeSearchesGauge.set(activeSearches);
    console.log(`[tax] REST search finished — active: ${activeSearches}/${MAX_CONCURRENT}`);
  }
});

module.exports = router;
module.exports.getCacheStats    = getCacheStats;
module.exports.getActiveSearches = getActiveSearches;
module.exports.MAX_CONCURRENT   = MAX_CONCURRENT;
