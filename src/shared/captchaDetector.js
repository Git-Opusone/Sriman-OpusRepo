'use strict';

/**
 * src/captchaDetector.js
 *
 * Shared CAPTCHA / bot-challenge detection for all Playwright handlers.
 *
 * Resolution tiers (in order):
 *   Tier 1 — Free self-solve:
 *     - Cloudflare 5-second JS challenge: wait for real Chromium to auto-pass (up to 25s)
 *     - Cloudflare Turnstile: wait for browser auto-solve + try clicking iframe checkbox
 *   Tier 2 — CapSolver (paid, last resort):
 *     - Only if Tier 1 exhausted AND CAPSOLVER_API_KEY is configured
 *     - Only for Cloudflare types (Turnstile + JS challenge)
 *   Blocked:
 *     - reCAPTCHA, hCaptcha, generic interstitials — returned as captchaBlocked
 *     - Cloudflare types that survive both tiers — returned as captchaBlocked
 */

const { solveTurnstile } = require('./captchaSolver');

const CAPTCHA_RESULT = (type) => ({
  detected: true,
  type,
  records: [],
  totalFound: 0,
  captchaBlocked: true,
  summary:
    `Search blocked by ${type} on this county website. ` +
    `This order could not be completed automatically and requires manual resolution.`,
});

// ─── Tier-1 helpers ───────────────────────────────────────────────────────────

/** Check whether the page is still showing a Cloudflare JS challenge. */
async function isJsChallengePending(page) {
  return page.evaluate(() => {
    const t    = (document.title || '').toLowerCase();
    const text = (document.body?.innerText || '').toLowerCase();
    return (
      t.includes('just a moment') ||
      (text.includes('checking your browser') && text.includes('cloudflare')) ||
      (text.includes('please wait') && text.includes('cloudflare') && !text.includes('search'))
    );
  }).catch(() => false);
}

/** Check whether a Turnstile widget is still visible. */
async function isTurnstilePending(page) {
  return page.evaluate(() => {
    const t = (document.title || '').toLowerCase();
    return t.includes('just a moment') || document.querySelector('.cf-turnstile') !== null;
  }).catch(() => false);
}

/**
 * Tier 1a — wait for Cloudflare JS challenge to auto-clear.
 * Real Chromium passes the 5-second JS challenge natively; we just need to wait.
 */
async function waitForJsChallengeToPass(page, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    if (!(await isJsChallengePending(page))) {
      console.log('[captcha] Cloudflare JS challenge passed automatically');
      return true;
    }
  }
  console.log('[captcha] Cloudflare JS challenge still pending after wait');
  return false;
}

/**
 * Tier 1b — wait for Turnstile to auto-clear, then try clicking the iframe checkbox.
 * Non-interactive ("managed") Turnstile sometimes auto-resolves; interactive ones
 * have a visible checkbox inside the challenges iframe.
 */
async function tryBrowserSolveTurnstile(page) {
  // Give the browser a moment — managed Turnstile can auto-approve
  await page.waitForTimeout(6000);
  if (!(await isTurnstilePending(page))) {
    console.log('[captcha] Turnstile auto-cleared by browser');
    return true;
  }

  // Try interacting with the Turnstile iframe checkbox
  try {
    const cfFrame = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
    if (cfFrame) {
      const checkbox = cfFrame.locator('input[type="checkbox"]').first();
      if (await checkbox.count() > 0 && await checkbox.isVisible({ timeout: 2000 })) {
        console.log('[captcha] clicking Turnstile checkbox in iframe');
        await checkbox.click();
        await page.waitForTimeout(4000);
      }
    }
  } catch (_) {}

  if (!(await isTurnstilePending(page))) {
    console.log('[captcha] Turnstile cleared after browser interaction');
    return true;
  }

  console.log('[captcha] Turnstile persisted after free attempts');
  return false;
}

// ─── Main detection + resolution ──────────────────────────────────────────────

/**
 * Inspect the current page for known CAPTCHA / challenge indicators.
 * Safe to call on any page — returns { detected: false } if nothing found.
 *
 * Resolution order:
 *   1. Identify CAPTCHA type
 *   2. Try free self-solve (Cloudflare types only)
 *   3. If still blocked, escalate to CapSolver (paid, last resort)
 *   4. If still blocked, return captchaBlocked result
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ detected: boolean, type: string|null, records?, totalFound?, captchaBlocked?, summary? }>}
 */
async function detectCaptcha(page) {
  try {
    const result = await page.evaluate(() => {
      const html  = document.documentElement.innerHTML;
      const text  = (document.body?.innerText || '').toLowerCase();
      const title = document.title.toLowerCase();

      // ── reCAPTCHA ──────────────────────────────────────────────────────────
      if (
        document.querySelector('iframe[src*="recaptcha"]') ||
        document.querySelector('.g-recaptcha') ||
        document.querySelector('#recaptcha') ||
        document.querySelector('script[src*="recaptcha"]') ||
        html.includes('grecaptcha')
      ) return { detected: true, type: 'reCAPTCHA' };

      // ── hCaptcha ───────────────────────────────────────────────────────────
      if (
        document.querySelector('iframe[src*="hcaptcha"]') ||
        document.querySelector('.h-captcha') ||
        html.includes('hcaptcha.com')
      ) return { detected: true, type: 'hCaptcha' };

      // ── Cloudflare Turnstile ───────────────────────────────────────────────
      if (
        document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
        document.querySelector('.cf-turnstile') ||
        html.includes('challenges.cloudflare.com')
      ) return { detected: true, type: 'Cloudflare Turnstile' };

      // ── Cloudflare 5-second JS challenge ──────────────────────────────────
      if (
        title.includes('just a moment') ||
        (text.includes('checking your browser') && text.includes('cloudflare')) ||
        (text.includes('please wait') && text.includes('cloudflare') && !text.includes('search'))
      ) return { detected: true, type: 'Cloudflare challenge' };

      // ── Generic interstitials ──────────────────────────────────────────────
      if (
        text.includes("i'm not a robot") ||
        text.includes('verify you are human') ||
        text.includes('prove you are human') ||
        text.includes('complete the captcha') ||
        (text.includes('captcha') && (text.includes('enter') || text.includes('type') || text.includes('solve')))
      ) return { detected: true, type: 'CAPTCHA challenge' };

      return { detected: false, type: null };
    });

    if (!result.detected) return { detected: false, type: null };

    console.log(`[captcha] Detected: ${result.type} on ${page.url()}`);

    // ── Tier 1: Free self-solve (Cloudflare types only) ────────────────────
    if (result.type === 'Cloudflare challenge') {
      const passed = await waitForJsChallengeToPass(page, 25000);
      if (passed) return { detected: false, type: null };
    }

    if (result.type === 'Cloudflare Turnstile') {
      const passed = await tryBrowserSolveTurnstile(page);
      if (passed) return { detected: false, type: null };
    }

    // ── Tier 2: CapSolver (paid — only when Tier 1 failed) ─────────────────
    if (
      process.env.CAPSOLVER_API_KEY &&
      (result.type === 'Cloudflare Turnstile' || result.type === 'Cloudflare challenge')
    ) {
      console.log('[captcha] Tier-1 exhausted — escalating to CapSolver (paid last resort)...');
      const solved = await solveTurnstile(page);
      if (solved) {
        await page.waitForTimeout(2000);
        const stillBlocked = await isTurnstilePending(page);
        if (!stillBlocked) {
          console.log('[captcha] CapSolver resolved the challenge — continuing');
          return { detected: false, type: null };
        }
        console.log('[captcha] CapSolver attempted but challenge still visible');
      }
    }

    // ── All tiers failed (or non-Cloudflare type) ──────────────────────────
    return { ...result, ...CAPTCHA_RESULT(result.type), searchedUrl: page.url() };

  } catch (_) {
    return { detected: false, type: null };
  }
}

module.exports = { detectCaptcha };
