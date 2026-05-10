'use strict';

/**
 * src/platformDetector.js
 *
 * Identifies which county CAD platform a URL belongs to.
 * Returns a platform key used to select the right Playwright handler.
 *
 * Platforms supported:
 *   bis          – BIS Consultants          (TX heavy, esearch.*.org)         ✅ handler built
 *   qpublic      – qPublic.net              (SE states: GA, FL, SC, NC, LA)   ✅ handler built
 *   tyler        – Tyler iasWorld           (nationwide, tylerhost.net)        ✅ handler built
 *   beacon       – Beacon/Schneider         (Midwest: IA, MN, WI, OH)         ✅ handler built
 *   patriot      – Patriot Props            (NE: MA, NH, CT, ME)              ✅ handler built
 *   vision       – Vision Gov               (NE states)                       ✅ handler built
 *   publicportal – Public Portal (Aumentum) (TX: {county}cad.net)             ✅ handler built
 *   generic      – everything else          (AI fallback)
 */

const PLATFORM_RULES = [
  // ── URL hostname patterns ──────────────────────────────────────────────────
  // Anderson County Tax Office — must be checked before any generic rules
  { platform: 'andersontax',  test: u => /tax\.co\.anderson\.tx\.us/i.test(u)           },
  // qpublic MUST come before beacon — qpublic.schneidercorp.com is qPublic, not Beacon
  { platform: 'qpublic',      test: u => /qpublic\.net/i.test(u)                        },
  { platform: 'qpublic',      test: u => /qpublic\.schneidercorp\.com/i.test(u)         },
  { platform: 'beacon',       test: u => /beacon\.schneidercorp\.com/i.test(u)          },
  { platform: 'beacon',       test: u => /\.schneidercorp\.com/i.test(u)                },
  { platform: 'tyler',        test: u => /tylerhost\.net/i.test(u)                      },
  { platform: 'tyler',        test: u => /iasworld/i.test(u)                            },
  { platform: 'tyler',        test: u => /tylertech\.com/i.test(u)                      },
  { platform: 'patriot',      test: u => /patriotproperties\.com/i.test(u)              },
  { platform: 'vision',       test: u => /visionappraisal\.com/i.test(u)                },
  { platform: 'vision',       test: u => /vgsi\.com/i.test(u)                           },
  // BIS rules MUST come before publicportal — esearch.fallscad.net is BIS, not Public Portal
  { platform: 'bis',          test: u => /esearch\.[a-z]+cad\.(org|net)/i.test(u)       },
  { platform: 'bis',          test: u => /bisconsultants\.com/i.test(u)                 },
  { platform: 'bis',          test: u => /cadcentral\.com/i.test(u)                     },
  // Public Portal (Aumentum Technologies) — Texas CADs with {county}cad.net domains
  { platform: 'publicportal', test: u => /andersoncad\.net/i.test(u)                    },
  { platform: 'publicportal', test: u => /harrisoncad\.net/i.test(u)                    },
  { platform: 'publicportal', test: u => /somervellcad\.net/i.test(u)                   },
  { platform: 'publicportal', test: u => /woodcad\.net/i.test(u)                        },
  { platform: 'publicportal', test: u => /tylercad\.net/i.test(u)                       },
  // ── Path / query patterns ─────────────────────────────────────────────────
  { platform: 'qpublic',      test: u => /\/qpublic\//i.test(u)                         },
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
  // Public Portal (Aumentum): SPA with minimal initial HTML; title is literally "Public Portal"
  if (h.includes('public portal') && (h.includes('cad') || h.includes('appraisal')))
                                                                          return 'publicportal';

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
    andersontax:  'Anderson County Tax Office',
    bis:          'BIS Consultants',
    qpublic:      'qPublic',
    tyler:        'Tyler iasWorld',
    beacon:       'Beacon / Schneider',
    patriot:      'Patriot Properties',
    vision:       'Vision Government Solutions',
    publicportal: 'Public Portal (Aumentum)',
    generic:      'Generic (AI-assisted)',
  };
  return labels[platform] || 'Unknown';
}

module.exports = { detectPlatform, detectFromUrl, detectFromHtml, platformLabel };
