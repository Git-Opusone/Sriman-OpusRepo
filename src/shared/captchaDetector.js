'use strict';

/**
 * src/captchaDetector.js
 *
 * Shared CAPTCHA / bot-challenge detection for all Playwright handlers.
 * Returns { detected, type } without attempting to solve.
 *
 * Covered patterns:
 *   - reCAPTCHA v2 / v3 (Google)
 *   - hCaptcha
 *   - Cloudflare Turnstile / 5-second JS challenge
 *   - Generic "verify you are human" interstitials
 */

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

/**
 * Inspect the current page for known CAPTCHA / challenge indicators.
 * Safe to call on any page — returns { detected: false } if nothing found.
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

    if (result.detected) {
      console.log(`[captcha] Detected: ${result.type} on ${page.url()}`);
      return { ...result, ...CAPTCHA_RESULT(result.type), searchedUrl: page.url() };
    }
    return { detected: false, type: null };
  } catch (_) {
    return { detected: false, type: null };
  }
}

module.exports = { detectCaptcha };
