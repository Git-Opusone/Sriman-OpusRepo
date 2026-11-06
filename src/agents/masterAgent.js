'use strict';

/**
 * src/agents/masterAgent.js
 *
 * Coordinates the per-state maintenance agents: keeps the registry of enabled
 * states, runs them nightly (one state at a time, so probes never exceed the
 * search-slot budget), and holds a lock so runs never overlap.
 *
 * Env:
 *   AGENTS_ENABLED       "true" to run on schedule (default off — local dev never sweeps)
 *   AGENT_STATES         comma list of states to run (default "TX")
 *   AGENT_RUN_HOUR       local hour to start the nightly run (default 2)
 *   AGENT_TZ             timezone for AGENT_RUN_HOUR (default America/Chicago)
 *   AGENT_CONCURRENCY    parallel probes per state on the nightly run (default 2; manual runs use 1)
 *   AGENT_AI_MAX         LLM diagnoses per state run (default 40)
 */

const store = require('./store');
const { runStateAgent } = require('./stateAgent');

// States with an agent. Adding a state = adding it here once its handlers are in place.
const REGISTRY = {
  TX: { name: 'Texas' },
};

let current = null;   // { state, runId, startedAt } while a run is in progress

function enabledStates() {
  return (process.env.AGENT_STATES || 'TX').split(',').map(s => s.trim().toUpperCase()).filter(s => REGISTRY[s]);
}

/**
 * Run the given states (default: all enabled) sequentially. Returns the runs,
 * or null if another run holds the lock.
 */
async function runAgents({ states, counties, trigger = 'manual', baseUrl, resume = {} } = {}) {
  if (current) return null;
  const list = (states && states.length ? states : enabledStates()).map(s => s.toUpperCase()).filter(s => REGISTRY[s]);
  const origin = baseUrl || `http://127.0.0.1:${process.env.PORT || 3000}`;
  const runs = [];
  try {
    for (const state of list) {
      current = { state, startedAt: new Date().toISOString() };
      runs.push(await runStateAgent({
        state, counties, trigger, baseUrl: origin, resume: resume[state] || null,
        // Manual runs happen in working hours: one probe at a time leaves room for a
        // user's multi-source search (up to 4 sources) within the slot budget
        concurrency: trigger === 'schedule' ? Number(process.env.AGENT_CONCURRENCY || 2) : 1,
        aiMax: Number(process.env.AGENT_AI_MAX || 40),
      }));
    }
  } finally {
    current = null;
  }
  return runs;
}

// ── Nightly schedule ────────────────────────────────────────────────────────
// Checked every 10 minutes against the wall clock in AGENT_TZ (DST-safe); the
// last run date is persisted so a restart during the run hour doesn't re-run.

function localParts(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function startScheduler() {
  if (process.env.AGENTS_ENABLED !== 'true') {
    console.log('[agents] scheduler disabled (set AGENTS_ENABLED=true to enable)');
    return;
  }
  const hour = Number(process.env.AGENT_RUN_HOUR || 2);
  const tz = process.env.AGENT_TZ || 'America/Chicago';
  const tick = async () => {
    const now = localParts(tz);
    const sched = store.getSchedulerState();
    if (now.hour !== hour || sched.lastRunDate === now.date || current) return;
    store.setSchedulerState({ ...sched, lastRunDate: now.date });
    console.log(`[agents] nightly run starting (${now.date} ${hour}:00 ${tz})`);
    try { await runAgents({ trigger: 'schedule' }); }
    catch (err) { console.error(`[agents] nightly run failed: ${err.message}`); }
  };
  setInterval(tick, 10 * 60 * 1000).unref();
  setTimeout(tick, 60 * 1000).unref();

  // A deploy/restart mid-run leaves an unfinished run — pick it up where it stopped
  setTimeout(async () => {
    for (const state of enabledStates()) {
      const run = store.latestRun(state);
      if (!run || run.finishedAt || current) continue;
      console.log(`[agents] resuming interrupted run ${run.id} (${run.done || 0}/${run.total})`);
      try { await runAgents({ states: [state], trigger: run.trigger, resume: { [state]: run } }); }
      catch (err) { console.error(`[agents] resume failed: ${err.message}`); }
    }
  }, 2 * 60 * 1000).unref();
  console.log(`[agents] scheduler on — ${enabledStates().join(', ')} nightly at ${hour}:00 ${tz}`);
}

function status() {
  return {
    running: current,
    states: Object.entries(REGISTRY).map(([code, s]) => ({ code, name: s.name, enabled: enabledStates().includes(code) })),
    schedule: {
      enabled: process.env.AGENTS_ENABLED === 'true',
      hour: Number(process.env.AGENT_RUN_HOUR || 2),
      tz: process.env.AGENT_TZ || 'America/Chicago',
      lastRunDate: store.getSchedulerState().lastRunDate || null,
    },
  };
}

module.exports = { REGISTRY, runAgents, startScheduler, status };
