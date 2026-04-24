'use strict';

require('dotenv').config();

// Prevent unhandled rejections / exceptions from crashing the server process
process.on('uncaughtException',  (err)    => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const { runBrowserAgent }               = require('./browserAgent');
const { getAllStates, getCountiesForState, getCountyUrl } = require('./src/countyDirectory');
const { resolveCountyUrl }              = require('./src/urlHealthCheck');
const { detectFromUrl, platformLabel }  = require('./src/platformDetector');

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

// ─── Concurrency guard ────────────────────────────────────────────────────────
// Each search spawns a full Chromium process (~400–500 MB RAM).
// Cap simultaneous searches so the server doesn't OOM under load.
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SEARCHES || '5', 10);
let activeSearches = 0;

// Per-request hard timeout — prevents a stuck county site from holding a
// connection open indefinitely. Configurable via env for slow networks.
const SEARCH_TIMEOUT_MS = parseInt(process.env.SEARCH_TIMEOUT_MS || String(3 * 60 * 1000), 10);

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

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'mortgage-search-service',
    timestamp: new Date().toISOString(),
    activeSearches,
    maxConcurrent: MAX_CONCURRENT,
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
  console.log(`[server] search started — active: ${activeSearches}/${MAX_CONCURRENT}`);

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

    sendEvent('progress', { message: `Using: ${searchUrl}` });

    const results = await runBrowserAgentWithTimeout({
      url: searchUrl,
      firstName:     firstName     || '',
      lastName:      lastName      || '',
      fullName:      fullName      || '',
      accountNumber: accountNumber || '',
      onProgress:    (message) => sendEvent('progress', { message }),
    });

    if (results.captchaBlocked) {
      sendEvent('captcha', {
        type:        results.captchaType || 'CAPTCHA',
        message:     results.summary,
        searchedUrl: results.searchedUrl,
      });
    }
    sendEvent('results', results);
    sendEvent('done', { success: true });
  } catch (err) {
    console.error('[server] Search error:', err.message);
    sendEvent('error', { message: err.message || 'An unexpected error occurred' });
  } finally {
    activeSearches--;
    console.log(`[server] search finished — active: ${activeSearches}/${MAX_CONCURRENT}`);
    clearInterval(heartbeat);
    res.end();
  }
});

// ─── REST fallback ────────────────────────────────────────────────────────────

app.post('/api/search', async (req, res) => {
  const { url, firstName, lastName, fullName, accountNumber } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  if (activeSearches >= MAX_CONCURRENT) {
    return res.status(503).json({
      success: false,
      error: `Server busy — ${activeSearches} searches already running (max ${MAX_CONCURRENT}). Please try again in a moment.`,
    });
  }

  activeSearches++;
  console.log(`[server] REST search started — active: ${activeSearches}/${MAX_CONCURRENT}`);

  try {
    const results = await runBrowserAgentWithTimeout({
      url,
      firstName:     firstName     || '',
      lastName:      lastName      || '',
      fullName:      fullName      || '',
      accountNumber: accountNumber || '',
    });

    if (results.captchaBlocked) {
      return res.status(422).json({
        success: false,
        captchaBlocked: true,
        captchaType:    results.captchaType || 'CAPTCHA',
        error:          results.summary,
        results,
      });
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('[server] REST search error:', err.message);
    const isTimeout = err.message.includes('timed out');
    res.status(isTimeout ? 504 : 500).json({ success: false, error: err.message });
  } finally {
    activeSearches--;
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
});
