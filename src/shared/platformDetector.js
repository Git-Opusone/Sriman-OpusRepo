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
 *   ptaxpro      – PTaxPro / whoownsit.com  (TX: {county}cad.com / .org)    ✅ handler built
 *   generic      – everything else          (AI fallback)
 */

const PLATFORM_RULES = [
  // ── URL hostname patterns ──────────────────────────────────────────────────
  // TX county tax offices (tax.co.{county}.tx.us) — must be checked before any generic rules
  { platform: 'txcountytax',  test: u => /tax\.co\.[a-z]+\.tx\.us/i.test(u)             },
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
  // ACTweb — TX county tax portal (actweb.acttax.com or {county}.acttax.com subdomains)
  { platform: 'actweb',       test: u => /acttax\.com/i.test(u)                        },
  // Houston County Tax Office uses BIS platform under a non-standard domain
  { platform: 'bis',          test: u => /houstoncountytaxoffice\.com/i.test(u)        },
  // Public Portal (Aumentum Technologies) — {county}cad.net / {county}cad.org domains
  // Specific known domains first; broad *cad.net pattern last (after BIS rules)
  { platform: 'publicportal', test: u => /andersoncad\.net/i.test(u)                    },
  { platform: 'publicportal', test: u => /harrisoncad\.net/i.test(u)                    },
  { platform: 'publicportal', test: u => /somervellcad\.net/i.test(u)                   },
  { platform: 'publicportal', test: u => /woodcad\.net/i.test(u)                        },
  { platform: 'publicportal', test: u => /tylercad\.net/i.test(u)                       },
  { platform: 'publicportal', test: u => /prodigycad\.com/i.test(u)                     },
  // Broad *cad.net catch-all — excludes esearch.* (BIS) and known non-portal domains
  { platform: 'publicportal', test: u => /[a-z]cad\.net\b/i.test(u) &&
      !/esearch\.|bisconsultants\.|cadcentral\.|qpublic/i.test(u)                        },
  // ── Path / query patterns ─────────────────────────────────────────────────
  { platform: 'qpublic',      test: u => /\/qpublic\//i.test(u)                         },
  // TylerTech CAMA (county-hosted, e.g. assessor.co.county.state.us/TylerCama)
  { platform: 'tyler',        test: u => /tylercama/i.test(u)                           },
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
  if (h.includes('tylertech') || h.includes('iasworld') || h.includes('tyler cama')) return 'tyler';
  if (h.includes('patriotproperties'))                                   return 'patriot';
  if (h.includes('visionappraisal') || h.includes('vgsi.com'))           return 'vision';
  if (h.includes('bisconsultants') || h.includes('bis consultants') ||
      h.includes('powered by: bis'))                                      return 'bis';
  // Public Portal (Aumentum): SPA title "Public Portal" or API path fingerprint
  if (h.includes('/api/searchresults/') || h.includes('searchresults/getdefaultsearch') ||
      h.includes('search/fulltext'))                                      return 'publicportal';
  if (h.includes('public portal') && (h.includes('cad') || h.includes('appraisal district')))
                                                                          return 'publicportal';
  // Aumentum React SPA public portals: title is exactly "Public Portal" but no CAD name in static HTML
  if (h.includes('<title>public portal</title>') && h.includes('/static/js/'))
                                                                          return 'publicportal';
  // PTaxPro / whoownsit.com county aggregator template
  if (h.includes('name-addr-acctno') || h.includes('whoownsit.com'))     return 'ptaxpro';

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
    txcountytax:  'TX County Tax Office (Kendo)',
    actweb:       'ACTweb Tax Portal',
    ptaxpro:      'PTaxPro / whoownsit.com',
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
