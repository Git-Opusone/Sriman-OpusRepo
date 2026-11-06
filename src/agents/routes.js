'use strict';

/**
 * src/agents/routes.js  →  /api/agents/*
 *
 *   GET  /status          scheduler state, running run, latest run per state, URL overrides
 *   GET  /runs?state=TX   run history (summaries only)
 *   GET  /runs/:id        one run in full
 *   POST /run             start a run — loopback only (docker exec … curl), since the
 *                         app has no auth and a run drives ~250 browser searches
 */

const express = require('express');
const store   = require('./store');
const master  = require('./masterAgent');

const router = express.Router();

const runSummary = run => run && ({
  id: run.id, state: run.state, trigger: run.trigger, partial: !!run.partial,
  startedAt: run.startedAt, finishedAt: run.finishedAt,
  total: run.total, done: run.done || 0, summary: run.summary,
  regressions: run.regressions, repairs: run.repairs, aiDiagnoses: run.aiDiagnoses,
});

router.get('/status', (req, res) => {
  const st = master.status();
  const states = st.states.map(s => {
    const run = store.currentView(s.code);
    return { ...s, latestRun: run ? { ...runSummary(run), partial: !!run.partial, rechecks: run.rechecks || [], counties: run.counties } : null };
  });
  res.json({ ...st, states, urlOverrides: store.getUrlOverrides() });
});

router.get('/runs', (req, res) => {
  const ids = store.listRuns(req.query.state).slice(0, 30);
  res.json(ids.map(f => runSummary(store.loadRun(f.replace(/\.json$/, '')))).filter(Boolean));
});

router.get('/runs/:id', (req, res) => {
  const run = store.loadRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

const isLoopback = ip => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

router.post('/run', (req, res) => {
  if (!isLoopback(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'Agent runs can only be started from inside the server' });
  }
  if (master.status().running) return res.status(409).json({ error: 'A run is already in progress' });
  const { states, counties } = req.body || {};
  master.runAgents({ states, counties, trigger: 'manual' })
    .catch(err => console.error(`[agents] manual run failed: ${err.message}`));
  res.status(202).json({ started: true, states: states || 'enabled', counties: counties || 'all' });
});

module.exports = router;
