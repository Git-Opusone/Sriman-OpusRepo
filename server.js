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

// ─── Shared utilities ─────────────────────────────────────────────────────────
const { getAllStates, getCountiesForState, getCountyUrl } = require('./src/shared/countyDirectory');
const { resolveCountyUrl, getAllNetronlineSources }        = require('./src/shared/urlHealthCheck');
const { detectFromUrl, platformLabel }                    = require('./src/shared/platformDetector');
const metrics                                             = require('./src/shared/metrics');

// ─── Namespaced route modules ─────────────────────────────────────────────────
const taxRoutes   = require('./src/tax/routes');
const titleRoutes = require('./src/title/routes');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Docs routes — registered FIRST, before any middleware ───────────────────
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

// ─── Shared utility endpoints (used by both tax and title UIs) ────────────────

// GET /api/health
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'mortgage-search-service',
    timestamp: new Date().toISOString(),
    activeSearches: taxRoutes.getActiveSearches(),
    maxConcurrent:  taxRoutes.MAX_CONCURRENT,
    cache:          taxRoutes.getCacheStats(),
  });
});

// GET /api/states
app.get('/api/states', (_req, res) => {
  res.json(getAllStates());
});

// GET /api/counties?state=TX
app.get('/api/counties', (req, res) => {
  const { state } = req.query;
  if (!state) return res.status(400).json({ error: 'state query param required' });
  res.json(getCountiesForState(state));
});

// GET /api/county-url?state=TX&county=Andrews
app.get('/api/county-url', async (req, res) => {
  const { state, county } = req.query;
  if (!state || !county) return res.status(400).json({ error: 'state and county required' });

  const lookup = getCountyUrl(state, county);

  if (!lookup.url) {
    return res.json({ url: null, platform: 'unknown', status: 'not_found',
      message: `No URL found for ${county}, ${state}. Try entering the URL manually.` });
  }

  const resolved = await resolveCountyUrl(lookup.url, state, county);
  const platform = detectFromUrl(resolved.url);

  return res.json({
    url:           resolved.url,
    platform,
    platformLabel: platformLabel(platform),
    status:        resolved.status,
    message:       resolved.message,
  });
});

// GET /api/zip-lookup?zip=75751
app.get('/api/zip-lookup', async (req, res) => {
  const zip = (req.query.zip || '').trim();
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'Valid 5-digit ZIP code required' });
  }

  try {
    const zipRes = await axios.get(`https://api.zippopotam.us/us/${zip}`, { timeout: 8000 });
    const place  = zipRes.data?.places?.[0];
    if (!place) return res.status(404).json({ error: `No location found for ZIP ${zip}` });

    const stateCode = place['state abbreviation'];
    if (!stateCode) return res.status(404).json({ error: `Could not determine state for ZIP ${zip}` });

    const lat  = parseFloat(place.latitude);
    const lon  = parseFloat(place.longitude);
    const city = place['place name'] || '';

    const fccRes = await axios.get(
      `https://geo.fcc.gov/api/census/block/find?latitude=${lat}&longitude=${lon}&format=json`,
      { timeout: 8000 }
    );
    const countyRaw  = fccRes.data?.County?.name || '';
    const countyName = countyRaw.replace(/\s+County$/i, '').trim();
    if (!countyName) return res.status(404).json({ error: `Could not determine county for ZIP ${zip}` });

    return res.json({ state: stateCode, county: countyName, city });
  } catch (err) {
    console.error('[zip-lookup]', err.message);
    return res.status(500).json({ error: 'ZIP lookup failed — please select state and county manually.' });
  }
});

// GET /api/county-sources?state=TX&county=Anderson
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

// ─── Namespaced search routes ─────────────────────────────────────────────────
app.use('/api/tax',   taxRoutes);    // → /api/tax/search/stream, /api/tax/search/dual/stream, etc.
app.use('/api/title', titleRoutes);  // → /api/title/search/stream, /api/title/health, etc.

// ─── Serve docs ───────────────────────────────────────────────────────────────
app.get('/docs/*', (req, res, next) => {
  const rel = req.path.replace(/^\/docs\//, '');
  const abs = path.resolve(path.join(__dirname, 'docs'), rel);
  if (!abs.startsWith(path.join(__dirname, 'docs'))) return next();
  res.sendFile(abs, err => { if (err && !res.headersSent) next(); });
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/docs/')) {
    const abs = path.join(__dirname, 'docs', req.path.replace(/^\/docs\//, ''));
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return res.sendFile(abs);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🏠 Mortgage Title & Tax Search Service`);
  console.log(`   Running at:  http://localhost:${PORT}`);
  console.log(`   Tax Search:  http://localhost:${PORT}/tax/`);
  console.log(`   Title Search:http://localhost:${PORT}/title/`);
  console.log(`   Health:      http://localhost:${PORT}/api/health`);
  console.log(`   Tax API:     /api/tax/search/dual/stream`);
  console.log(`   Title API:   /api/title/search/stream`);
  console.log(`   Concurrency: max ${taxRoutes.MAX_CONCURRENT} simultaneous searches`);
  console.log(`   Counties DB: ${fs.existsSync('./data/counties.json') ? '✅ loaded' : '⚠️  not built yet — run: node scripts/buildCountyDirectory.js'}\n`);
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
