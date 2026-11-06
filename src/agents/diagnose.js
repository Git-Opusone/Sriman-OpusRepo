'use strict';

/**
 * src/agents/diagnose.js
 *
 * Classifies a county probe into a health category with rules, then — for the
 * unclear failures only — asks the LLM for a likely cause and next step.
 *
 * Categories:
 *   healthy      dedicated handler returned records
 *   degraded_ai  records came back only via the AI fallback (handler missing or broken)
 *   blocked      CAPTCHA / Cloudflare challenge — needs a human decision, never bypassed
 *   site_down    county server unreachable, DNS failure, 5xx, navigation timeout
 *   no_results   a dedicated handler ran cleanly but found nothing for any sample surname
 *   failing      anything else (errors, timeouts, unparsed pages)
 */

const OpenAI = require('openai');

const NETWORK_RX = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|ERR_TIMED_OUT|net::ERR|\b50[0-4]\b|unresponsive|URL appears dead|could not find a live/i;

function classify(probe) {
  if (probe.status === 'captcha') return 'blocked';
  if (probe.status === 'ok') return probe.engine && probe.engine !== 'ai' ? 'healthy' : 'degraded_ai';
  const text = [probe.summary, ...(probe.progress || [])].join(' ');
  if (NETWORK_RX.test(text)) return 'site_down';
  // "Nothing for Smith or Johnson" is believable from a dedicated handler in a tiny
  // county, but from the AI fallback it means the agent couldn't drive the site
  if (probe.status === 'none') return probe.engine && probe.engine !== 'ai' ? 'no_results' : 'failing';
  return 'failing';
}

let _client = null;
function client() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

const SYSTEM = `You maintain a property-tax search service that automates US county appraisal-district (CAD) websites with per-platform Playwright handlers and a generic AI-browser fallback.
Given one county's failed probe, reply with JSON only:
{"likelyCause": "<one sentence>", "suggestedAction": "<one sentence a developer can act on>", "category": "<one of: url_moved, layout_changed, site_down, blocked, no_data, handler_bug, unknown>"}
Be concrete and brief. Do not suggest bypassing CAPTCHAs or bot protection — for those say a human must decide.`;

/**
 * LLM diagnosis for one probe. Returns null when no key is configured or the
 * call fails — diagnosis is advisory and must never break a run.
 */
async function aiDiagnose({ state, county, platform, url, probe, category }) {
  const c = client();
  if (!c) return null;
  const facts = {
    state, county, directoryPlatform: platform, url, ruleCategory: category,
    status: probe.status, engine: probe.engine || 'ai', records: probe.n || 0,
    summary: probe.summary, lastProgressMessages: (probe.progress || []).slice(-8),
    searchedUrl: probe.searchedUrl,
  };
  try {
    const res = await c.chat.completions.create({
      model: process.env.AGENT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify(facts) },
      ],
    });
    const out = JSON.parse(res.choices[0].message.content || '{}');
    return {
      likelyCause: String(out.likelyCause || '').slice(0, 300),
      suggestedAction: String(out.suggestedAction || '').slice(0, 300),
      category: String(out.category || 'unknown').slice(0, 30),
    };
  } catch (err) {
    console.log(`[agents] AI diagnosis failed for ${state}/${county}: ${err.message}`);
    return null;
  }
}

module.exports = { classify, aiDiagnose };
