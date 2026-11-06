'use strict';

/**
 * src/agents/store.js
 *
 * Persistent state for the county-maintenance agents. Lives in AGENT_DATA_DIR
 * (a Docker volume in production, so it survives redeploys):
 *
 *   runs/<runId>.json      one file per agent run (per-county probe results)
 *   baselines.json         last healthy probe per county  { "TX|Anderson": {...} }
 *   url-overrides.json     agent-verified URL repairs     { "TX|Bastrop": {...} }
 *   scheduler.json         last scheduled run date per state
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(__dirname, '../../agent-data');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const KEEP_RUNS = 60;

function ensureDirs() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

// Write via temp file + rename so a crash mid-write never leaves half a file
function writeJson(file, data) {
  ensureDirs();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

const key = (state, county) => `${state.toUpperCase()}|${county}`;

// ── Runs ────────────────────────────────────────────────────────────────────

function saveRun(run) {
  writeJson(path.join(RUNS_DIR, `${run.id}.json`), run);
  pruneRuns();
}

function listRuns(state) {
  ensureDirs();
  return fs.readdirSync(RUNS_DIR)
    .filter(f => f.endsWith('.json') && (!state || f.startsWith(`${state.toUpperCase()}-`)))
    .sort().reverse();
}

function loadRun(id) {
  if (!/^[A-Z]{2}-[\dTZ-]+$/.test(id || '')) return null;   // ids are "<STATE>-<timestamp>"
  return readJson(path.join(RUNS_DIR, `${id}.json`), null);
}

function latestRun(state, { finishedOnly = false, fullOnly = false } = {}) {
  for (const f of listRuns(state)) {
    const run = readJson(path.join(RUNS_DIR, f), null);
    if (run && (!finishedOnly || run.finishedAt) && (!fullOnly || !run.partial)) return run;
  }
  return null;
}

/**
 * Current picture of a state: the latest full run (finished or in progress),
 * with any later partial re-checks (e.g. one county after a fix) laid on top.
 */
function currentView(state) {
  const files = listRuns(state);
  const later = [];
  for (const f of files) {
    const run = readJson(path.join(RUNS_DIR, f), null);
    if (!run) continue;
    if (run.partial) { if (run.finishedAt) later.push(run); continue; }
    const view = { ...run, counties: { ...run.counties }, rechecks: [] };
    for (const p of later.reverse()) {   // oldest re-check first, newest wins
      for (const [county, r] of Object.entries(p.counties)) view.counties[county] = { ...r, fromRun: p.id };
      view.rechecks.push(p.id);
    }
    view.summary = {};
    for (const r of Object.values(view.counties)) view.summary[r.category] = (view.summary[r.category] || 0) + 1;
    view.regressions = Object.values(view.counties).filter(r => r.regression)
      .map(r => ({ county: r.county, from: r.regressionFrom, to: r.category }));
    return view;
  }
  return later.length ? later[0] : null;   // only partial runs so far
}

function pruneRuns() {
  const files = listRuns();
  const byState = {};
  for (const f of files) (byState[f.slice(0, 2)] = byState[f.slice(0, 2)] || []).push(f);
  for (const list of Object.values(byState)) {
    for (const f of list.slice(KEEP_RUNS)) fs.rmSync(path.join(RUNS_DIR, f), { force: true });
  }
}

// ── Baselines / overrides / scheduler ───────────────────────────────────────

const file = name => path.join(DATA_DIR, name);

const getBaselines = () => readJson(file('baselines.json'), {});
function setBaseline(state, county, probe) {
  const all = getBaselines();
  all[key(state, county)] = probe;
  writeJson(file('baselines.json'), all);
}

// URL overrides are read on every county lookup — cache by mtime
let _ovCache = null, _ovMtime = 0;
function getUrlOverrides() {
  try {
    const m = fs.statSync(file('url-overrides.json')).mtimeMs;
    if (!_ovCache || m !== _ovMtime) { _ovCache = readJson(file('url-overrides.json'), {}); _ovMtime = m; }
  } catch (_) { _ovCache = {}; }
  return _ovCache;
}
function getUrlOverride(state, county) {
  return getUrlOverrides()[key(state, county)] || null;
}
// override = null removes it
function setUrlOverride(state, county, override) {
  const all = { ...getUrlOverrides() };
  if (override) all[key(state, county)] = override;
  else delete all[key(state, county)];
  writeJson(file('url-overrides.json'), all);
  _ovCache = all;
  _ovMtime = fs.statSync(file('url-overrides.json')).mtimeMs;
}

const getSchedulerState = () => readJson(file('scheduler.json'), {});
const setSchedulerState = s => writeJson(file('scheduler.json'), s);

module.exports = {
  DATA_DIR, key,
  saveRun, listRuns, loadRun, latestRun, currentView,
  getBaselines, setBaseline,
  getUrlOverrides, getUrlOverride, setUrlOverride,
  getSchedulerState, setSchedulerState,
};
