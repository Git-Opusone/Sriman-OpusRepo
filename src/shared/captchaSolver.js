'use strict';

/**
 * CapSolver REST API integration for Cloudflare Turnstile solving.
 * https://docs.capsolver.com/en/guide/captcha/cloudflare_turnstile/
 *
 * Set CAPSOLVER_API_KEY in .env (get from dashboard.capsolver.com → Overview → Client Key)
 *
 * Usage:
 *   const { solveTurnstile } = require('./captchaSolver');
 *   const token = await solveTurnstile(page);   // returns token string or null
 */

const https = require('https');

const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY || '';
const API_BASE          = 'api.capsolver.com';
const MAX_POLL_SECONDS  = 120;
const POLL_INTERVAL_MS  = 3000;

// ─── REST API helpers ─────────────────────────────────────────────────────────

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: API_BASE,
      path,
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 30000,
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('CapSolver request timeout')); });
    req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Create a task and poll for the result ────────────────────────────────────

async function solveTask(taskBody) {
  if (!CAPSOLVER_API_KEY) {
    console.log('[capsolver] CAPSOLVER_API_KEY not set — skipping solve');
    return null;
  }

  // Create task
  const createRes = await postJson('/createTask', {
    clientKey: CAPSOLVER_API_KEY,
    task:      taskBody,
  });

  if (createRes.errorId !== 0) {
    console.log(`[capsolver] createTask error: ${createRes.errorCode} — ${createRes.errorDescription}`);
    return null;
  }

  const taskId = createRes.taskId;
  console.log(`[capsolver] task created: ${taskId} (type: ${taskBody.type})`);

  // Poll for result
  const deadline = Date.now() + MAX_POLL_SECONDS * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const result = await postJson('/getTaskResult', {
      clientKey: CAPSOLVER_API_KEY,
      taskId,
    });

    if (result.status === 'ready') {
      const token = result.solution?.token || result.solution?.gRecaptchaResponse || '';
      console.log(`[capsolver] solved — token: ${token.slice(0, 40)}...`);
      return token;
    }
    if (result.status === 'failed' || result.errorId !== 0) {
      console.log(`[capsolver] task failed: ${result.errorCode} — ${result.errorDescription}`);
      return null;
    }
    console.log(`[capsolver] status: ${result.status} — waiting...`);
  }

  console.log('[capsolver] timed out waiting for task result');
  return null;
}

// ─── Turnstile solver ─────────────────────────────────────────────────────────

/**
 * Detects Cloudflare Turnstile on the current page, solves it via CapSolver,
 * and injects the token so the page can proceed.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} true if solved and injected, false otherwise
 */
async function solveTurnstile(page) {
  if (!CAPSOLVER_API_KEY) return false;

  try {
    // Extract sitekey from cf-turnstile widget
    const siteKey = await page.evaluate(() => {
      const el = document.querySelector('[data-sitekey], .cf-turnstile, [class*="turnstile"]');
      if (!el) return null;
      return el.getAttribute('data-sitekey') ||
             el.getAttribute('data-key') ||
             el.getAttribute('sitekey') || null;
    }).catch(() => null);

    if (!siteKey) {
      // Try extracting from page source as fallback
      const src = await page.content().catch(() => '');
      const m   = src.match(/['"]sitekey['"]\s*:\s*['"]([0-9A-Za-z_-]{20,})['"]/i)
               || src.match(/data-sitekey=['"]([0-9A-Za-z_-]{20,})['"]/i);
      if (!m) {
        console.log('[capsolver] Turnstile sitekey not found on page');
        return false;
      }
    }

    const websiteURL = page.url();
    const websiteKey = siteKey || '';
    console.log(`[capsolver] solving Turnstile — url=${websiteURL} sitekey=${websiteKey.slice(0, 20)}...`);

    const token = await solveTask({
      type:        'AntiTurnstileTaskProxyLess',
      websiteURL,
      websiteKey,
    });

    if (!token) return false;

    // Inject the token into the page
    const injected = await page.evaluate(t => {
      // Method 1: find the Turnstile response textarea and set its value
      const ta = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
      if (ta) { ta.value = t; return true; }

      // Method 2: call Turnstile callback if exposed
      if (window.turnstile && typeof window.turnstile.reset === 'function') {
        // Some implementations expose a callback
      }

      // Method 3: dispatch a custom event to trigger the widget
      const cfEl = document.querySelector('.cf-turnstile, [data-sitekey]');
      if (cfEl) {
        const cb = cfEl.getAttribute('data-callback');
        if (cb && typeof window[cb] === 'function') { window[cb](t); return true; }
      }

      // Method 4: set global token directly (works for some implementations)
      window.__cfTurnstileToken = t;
      return false;
    }, token);

    console.log(`[capsolver] token injected: ${injected}`);

    // Submit if injection succeeded
    if (injected) {
      await page.waitForTimeout(500);
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
          page.click('button[type="submit"], input[type="submit"]', { timeout: 3000 }),
        ]);
      } catch (_) {}
    }

    return true;
  } catch (err) {
    console.log(`[capsolver] error: ${err.message}`);
    return false;
  }
}

// ─── Balance check ────────────────────────────────────────────────────────────

async function getBalance() {
  if (!CAPSOLVER_API_KEY) return null;
  try {
    const res = await postJson('/getBalance', { clientKey: CAPSOLVER_API_KEY });
    return res.balance;
  } catch (_) { return null; }
}

module.exports = { solveTurnstile, getBalance, solveTask };
