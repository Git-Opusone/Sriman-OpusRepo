'use strict';

/**
 * src/platformDetector.js
 *
 * Identifies which county CAD platform a URL belongs to.
 * Returns a platform key used to select the right Playwright handler.
 *
 * Platforms supported:
 *   bis      – BIS Consultants  (TX heavy, esearch.*.org)         ✅ handler built
 *   qpublic  – qPublic.net      (SE states: GA, FL, SC, NC, LA)   handler planned
 *   tyler    – Tyler iasWorld   (nationwide, tylerhost.net)        handler planned
 *   beacon   – Beacon/Schneider (Midwest: IA, MN, WI, OH)         handler planned
 *   patriot  – Patriot Props    (NE: MA, NH, CT, ME)              handler planned
 *   vision   – Vision Gov       (NE states)                       handler planned
 *   generic  – everything else  (AI fallback)
 */

const PLATFORM_RULES = [
  // ── URL hostname patterns ──────────────────────────────────────────────────
  // qpublic MUST come before beacon — qpublic.schneidercorp.com is qPublic, not Beacon
  { platform: 'qpublic',  test: u => /qpublic\.net/i.test(u)                        },
  { platform: 'qpublic',  test: u => /qpublic\.schneidercorp\.com/i.test(u)         },
  { platform: 'beacon',   test: u => /beacon\.schneidercorp\.com/i.test(u)          },
  { platform: 'beacon',   test: u => /\.schneidercorp\.com/i.test(u)                },
  { platform: 'tyler',    test: u => /tylerhost\.net/i.test(u)                      },
  { platform: 'tyler',    test: u => /iasworld/i.test(u)                            },
  { platform: 'tyler',    test: u => /tylertech\.com/i.test(u)                      },
  { platform: 'patriot',  test: u => /patriotproperties\.com/i.test(u)              },
  { platform: 'vision',   test: u => /visionappraisal\.com/i.test(u)                },
  { platform: 'vision',   test: u => /vgsi\.com/i.test(u)                           },
  { platform: 'bis',      test: u => /esearch\.[a-z]+cad\.org/i.test(u)             },
  { platform: 'bis',      test: u => /bisconsultants\.com/i.test(u)                 },
  { platform: 'bis',      test: u => /cadcentral\.com/i.test(u)                     },
  // ── Path / query patterns ─────────────────────────────────────────────────
  { platform: 'qpublic',  test: u => /\/qpublic\//i.test(u)                         },
];

/**
 * Detect platform from URL string alone (fast, synchronous).
 * @param {string} url
 * @returns {string} platform key
 */
function detectFromUrl(url) {
  if (!url) return 'generic';
  for (const rule of PLATFORM_RULES) {
    if (rule.test(url)) return rule.platform;
  }
  return 'generic';
}

/**
 * Detect platform from live page HTML (more accurate for ambiguous URLs).
 * Looks for known fingerprints in the page source.
 * @param {string} html  – raw page HTML
 * @returns {string} platform key
 */
function detectFromHtml(html) {
  if (!html) return 'generic';
  const h = html.toLowerCase();

  // qpublic.schneidercorp.com check must come before generic schneidercorp check
  if (h.includes('qpublic.schneidercorp') || h.includes('qpublic.net') || h.includes('q-public')) return 'qpublic';
  if (h.includes('beacon.schneidercorp') || h.includes('schneidercorp')) return 'beacon';
  if (h.includes('tylertech') || h.includes('iasworld'))                 return 'tyler';
  if (h.includes('patriotproperties'))                                   return 'patriot';
  if (h.includes('visionappraisal') || h.includes('vgsi'))               return 'vision';
  if (h.includes('bisconsultants') || h.includes('bis consultants') ||
      h.includes('powered by: bis'))                                      return 'bis';

  return 'generic';
}

/**
 * Combined detection: URL first, then HTML fingerprint as fallback.
 */
function detectPlatform(url, html) {
  const fromUrl = detectFromUrl(url);
  if (fromUrl !== 'generic') return fromUrl;
  if (html) return detectFromHtml(html);
  return 'generic';
}

/**
 * Human-readable platform name for display.
 */
function platformLabel(platform) {
  const labels = {
    bis:     'BIS Consultants',
    qpublic: 'qPublic',
    tyler:   'Tyler iasWorld',
    beacon:  'Beacon / Schneider',
    patriot: 'Patriot Properties',
    vision:  'Vision Government Solutions',
    generic: 'Generic (AI-assisted)',
  };
  return labels[platform] || 'Unknown';
}

module.exports = { detectPlatform, detectFromUrl, detectFromHtml, platformLabel };
