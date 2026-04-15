'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { runBrowserAgent } = require('./browserAgent');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mortgage-search-service', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// SSE Search Endpoint
// Streams progress events and final results back to the browser in real time.
// ---------------------------------------------------------------------------
app.get('/api/search/stream', async (req, res) => {
  const { url, firstName, lastName, fullName, accountNumber } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'url query parameter is required' });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // Flush is not a standard method but works in Express with some transports
    if (typeof res.flush === 'function') res.flush();
  };

  // Keep connection alive with heartbeats
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  req.on('close', () => clearInterval(heartbeat));

  try {
    sendEvent('status', { message: 'Starting AI-powered search...' });

    const results = await runBrowserAgent({
      url,
      firstName: firstName || '',
      lastName: lastName || '',
      fullName: fullName || '',
      accountNumber: accountNumber || '',
      onProgress: (message) => sendEvent('progress', { message }),
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

// ---------------------------------------------------------------------------
// REST Search Endpoint (non-streaming fallback)
// ---------------------------------------------------------------------------
app.post('/api/search', async (req, res) => {
  const { url, firstName, lastName, fullName, accountNumber } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  try {
    const results = await runBrowserAgent({
      url,
      firstName: firstName || '',
      lastName: lastName || '',
      fullName: fullName || '',
      accountNumber: accountNumber || '',
    });
    res.json({ success: true, results });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Serve frontend
// ---------------------------------------------------------------------------
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🏠 Mortgage Title & Tax Search Service`);
  console.log(`   Running at: http://localhost:${PORT}`);
  console.log(`   Health:     http://localhost:${PORT}/api/health\n`);
});
