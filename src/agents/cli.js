'use strict';

/**
 * Start an agent run on the running server (must be run inside the container):
 *
 *   node src/agents/cli.js run [TX] [--counties "Anderson,Galveston"]
 *   node src/agents/cli.js status
 *
 * e.g.  docker exec opus-one-app node src/agents/cli.js run TX --counties Anderson
 */

const base = `http://127.0.0.1:${process.env.PORT || 3000}/api/agents`;
const [cmd = 'status', ...rest] = process.argv.slice(2);

(async () => {
  if (cmd === 'run') {
    const states = rest.filter(a => /^[A-Za-z]{2}$/.test(a)).map(s => s.toUpperCase());
    const ci = rest.indexOf('--counties');
    const counties = ci >= 0 ? String(rest[ci + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const res = await fetch(`${base}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ states: states.length ? states : undefined, counties }),
    });
    console.log(res.status, await res.text());
  } else {
    const s = await (await fetch(`${base}/status`)).json();
    console.log(JSON.stringify({ running: s.running, schedule: s.schedule,
      latest: s.states.map(x => x.latestRun && { id: x.latestRun.id, done: `${x.latestRun.done}/${x.latestRun.total}`, summary: x.latestRun.summary }) }, null, 1));
  }
})().catch(err => { console.error(err.message); process.exit(1); });
