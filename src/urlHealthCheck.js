'use strict';

/**
 * src/urlHealthCheck.js
 *
 * 1. checkUrlHealth(url)              → 'alive' | 'dead'
 *    Quick HEAD/GET request — if the URL responds with a valid status
 *    and stays on the same base domain, it is "alive".
 *
 * 2. findLiveUrl(stateCode, countyName) → newUrl | null
 *    Scrapes publicrecords.netronline.com for the county and returns
 *    the current property search URL.  Called only when stored URL is dead.
 */

const axios   = require('axios');
const { updateCountyUrl } = require('./countyDirectory');

const NETRONLINE_BASE = 'https://publicrecords.netronline.com';
const TIMEOUT_ALIVE   = 8000;   // ms for health check
const TIMEOUT_SCRAPE  = 15000;  // ms for netronline scrape

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

// Keywords that indicate a property search link (priority order)
const PROPERTY_KEYWORDS = [
  'assessor', 'appraisal district', 'appraisal', ' cad', 'cad ',
  'property search', 'property tax', 'tax commissioner',
  'tax search', 'treasurer tax', 'tax assessor', 'tax office',
];
const SKIP_HREF = ['netronline.com','historicaerials.com','datastore.','map.netronline'];
const SKIP_TEXT = ['clerk','recorder','gis','mapping','aerial','vital','ucc','corporation'];

function detectPlatform(url) {
  if (!url) return 'unknown';
  const u = url.toLowerCase();
  if (u.includes('qpublic.net'))                                    return 'qpublic';
  if (u.includes('beacon.schneidercorp') || u.includes('schneidercorp')) return 'beacon';
  if (u.includes('tylerhost') || u.includes('iasworld') || u.includes('tylertech')) return 'tyler';
  if (u.includes('patriotproperties'))                              return 'patriot';
  if (u.includes('visionappraisal') || u.includes('vgsi'))         return 'vision';
  if (u.includes('esearch') || u.includes('bisconsultants') || u.includes('cadcentral')) return 'bis';
  return 'generic';
}

function baseDomain(url) {
  try {
    const { hostname } = new URL(url);
    // Return last two parts of hostname (e.g. andrewscad.org)
    return hostname.split('.').slice(-2).join('.');
  } catch (_) {
    return '';
  }
}

/**
 * Returns 'alive' or 'dead'.
 * Fast: uses HEAD first, falls back to GET if HEAD is rejected.
 */
async function checkUrlHealth(url) {
  if (!url) return 'dead';
  const originalDomain = baseDomain(url);

  const tryRequest = async (method) => {
    const res = await axios({ method, url, headers: HEADERS, timeout: TIMEOUT_ALIVE,
      maxRedirects: 5,
      validateStatus: () => true,   // don't throw on 4xx/5xx
    });
    return res;
  };

  try {
    let res;
    try {
      res = await tryRequest('HEAD');
    } catch (_) {
      res = await tryRequest('GET');
    }

    const status    = res.status;
    const finalUrl  = res.request?.res?.responseUrl || url;
    const finalDomain = baseDomain(finalUrl);

    // Dead if 4xx/5xx or redirected to a completely different domain
    if (status >= 400) return 'dead';
    if (finalDomain && originalDomain && finalDomain !== originalDomain) {
      // Allow sub-domain changes (www.x.com → x.com) but catch full domain swaps
      console.log(`[healthCheck] Domain changed: ${originalDomain} → ${finalDomain}`);
      return 'dead';
    }

    return 'alive';
  } catch (err) {
    console.log(`[healthCheck] ${url} → dead (${err.message})`);
    return 'dead';
  }
}

/**
 * Scrape netronline for the current property search URL of a county.
 * Updates countyDirectory if a new URL is found.
 * Returns the new URL or null.
 */
async function findLiveUrl(stateCode, countyName) {
  const countySlug = countyName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const netronlineUrl = `${NETRONLINE_BASE}/state/${stateCode.toUpperCase()}/county/${countySlug}`;

  console.log(`[urlHealthCheck] Scraping netronline: ${netronlineUrl}`);

  try {
    const res  = await axios.get(netronlineUrl, { headers: HEADERS, timeout: TIMEOUT_SCRAPE });
    const html = res.data;

    // Simple regex-based extraction (avoid cheerio dependency in production)
    const linkRegex = /<a\s+[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const links = [];
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1].trim();
      const text = match[2].replace(/<[^>]+>/g, '').trim();
      links.push({ href, text });
    }

    // Filter out irrelevant links
    const candidates = links.filter(({ href, text }) => {
      const h = href.toLowerCase();
      const t = text.toLowerCase();
      if (SKIP_HREF.some(s => h.includes(s))) return false;
      if (SKIP_TEXT.some(s => t.includes(s))) return false;
      return true;
    });

    // Pick best by priority
    let bestUrl = null;
    for (const keyword of PROPERTY_KEYWORDS) {
      const found = candidates.find(l => l.text.toLowerCase().includes(keyword));
      if (found) { bestUrl = found.href; break; }
    }
    if (!bestUrl && candidates.length > 0) bestUrl = candidates[0].href;

    if (bestUrl) {
      const platform = detectPlatform(bestUrl);
      updateCountyUrl(stateCode, countyName, bestUrl, platform);
      console.log(`[urlHealthCheck] Found new URL for ${stateCode}/${countyName}: ${bestUrl}`);
    } else {
      console.log(`[urlHealthCheck] No URL found on netronline for ${stateCode}/${countyName}`);
    }

    return bestUrl;
  } catch (err) {
    console.error(`[urlHealthCheck] netronline scrape failed: ${err.message}`);
    return null;
  }
}

/**
 * Master function: checks stored URL, refreshes via netronline if dead.
 * Returns { url, status: 'alive'|'refreshed'|'dead', message }
 */
async function resolveCountyUrl(storedUrl, stateCode, countyName) {
  // 1. Quick health check on stored URL
  const health = await checkUrlHealth(storedUrl);

  if (health === 'alive') {
    return { url: storedUrl, status: 'alive', message: 'URL is active' };
  }

  // 2. URL is dead — find the updated one from netronline
  console.log(`[urlHealthCheck] ${storedUrl} is dead — searching netronline for updated URL`);
  const newUrl = await findLiveUrl(stateCode, countyName);

  if (newUrl) {
    return {
      url: newUrl,
      status: 'refreshed',
      message: `County URL was updated. Old: ${storedUrl} → New: ${newUrl}`,
    };
  }

  return {
    url: storedUrl,   // fall back to stored URL and let the search fail gracefully
    status: 'dead',
    message: `URL appears inactive and no updated URL found on netronline for ${stateCode}/${countyName}.`,
  };
}

module.exports = { checkUrlHealth, findLiveUrl, resolveCountyUrl };
