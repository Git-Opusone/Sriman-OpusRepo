'use strict';

require('dotenv').config();

// Prevent unhandled rejections / exceptions from crashing the server process
process.on('uncaughtException',  (err)    => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { runBrowserAgent }               = require('./browserAgent');
const { getAllStates, getCountiesForState, getCountyUrl } = require('./src/countyDirectory');
const { resolveCountyUrl }              = require('./src/urlHealthCheck');
const { detectFromUrl, platformLabel }  = require('./src/platformDetector');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  res.json({ status: 'ok', service: 'mortgage-search-service', timestamp: new Date().toISOString() });
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

    const results = await runBrowserAgent({
      url: searchUrl,
      firstName:     firstName     || '',
      lastName:      lastName      || '',
      fullName:      fullName      || '',
      accountNumber: accountNumber || '',
      onProgress:    (message) => sendEvent('progress', { message }),
    });

    sendEvent('results', results);
    sendEvent('done', { success: true });
  } catch (err) {
    console.error('Search error:', err);
    sendEvent('error', { message: err.message || 'An unexpected error occurred' });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// ─── REST fallback ────────────────────────────────────────────────────────────

app.post('/api/search', async (req, res) => {
  const { url, firstName, lastName, fullName, accountNumber } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const results = await runBrowserAgent({ url, firstName: firstName || '',
      lastName: lastName || '', fullName: fullName || '', accountNumber: accountNumber || '' });
    res.json({ success: true, results });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Serve frontend ───────────────────────────────────────────────────────────

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🏠 Mortgage Title & Tax Search Service`);
  console.log(`   Running at: http://localhost:${PORT}`);
  console.log(`   Health:     http://localhost:${PORT}/api/health`);
  console.log(`   Counties DB: ${require('fs').existsSync('./data/counties.json') ? '✅ loaded' : '⚠️  not built yet — run: node scripts/buildCountyDirectory.js'}\n`);
});
