'use strict';

/**
 * county-tester.js
 *
 * Tests a single county by:
 *   1. Searching by lastName "Smith" (falls back to "Johnson", "Williams")
 *   2. Extracting the first parcelId from results
 *   3. Searching by that parcelId
 *   4. Returning structured test result
 */

const http  = require('http');
const https = require('https');

const FALLBACK_NAMES    = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones'];
const NAME_TIMEOUT_MS   = 165_000;   // slightly below server's 3-min Playwright timeout
const ID_TIMEOUT_MS     = 165_000;
const MAX_503_RETRIES   = 8;         // retry up to 8× when server is busy
const RETRY_BASE_MS     = 15_000;    // first wait 15s, then 30s, 45s … (linear backoff)

// ─── SSE Client ───────────────────────────────────────────────────────────────

function sseSearch(serverUrl, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const qs  = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
    ).toString();
    const fullUrl = `${serverUrl}/api/tax/search/stream?${qs}`;
    const lib     = fullUrl.startsWith('https') ? https : http;

    const result = {
      records: [],
      totalFound: 0,
      summary: '',
      searchedUrl: '',
      captchaBlocked: false,
      captchaType: null,
      error: null,
      progressMessages: [],
      rawParams: params,
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { req.destroy(); } catch (_) {}
      reject(new Error(`SSE timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = lib.get(fullUrl, { headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        reject(new Error(`HTTP ${res.statusCode} from ${fullUrl}`));
        return;
      }

      let buffer      = '';
      let currentEvt  = null;
      let resolved    = false;

      const finish = (reason) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        try { req.destroy(); } catch (_) {}
        resolve(result);
      };

      res.on('data', (chunk) => {
        if (timedOut) return;
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete last line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue; // heartbeat / comment

          if (trimmed.startsWith('event: ')) {
            currentEvt = trimmed.slice(7).trim();
          } else if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              switch (currentEvt) {
                case 'results':
                  if (Array.isArray(data.records))  result.records    = data.records;
                  if (data.totalFound != null)       result.totalFound = data.totalFound;
                  if (data.summary)                  result.summary    = data.summary;
                  if (data.searchedUrl)              result.searchedUrl = data.searchedUrl;
                  break;
                case 'captcha':
                  result.captchaBlocked = true;
                  result.captchaType    = data.type || 'CAPTCHA';
                  break;
                case 'progress':
                  if (data.message) result.progressMessages.push(data.message);
                  break;
                case 'done':
                  finish('done event');
                  break;
                case 'error':
                  result.error = data.message || 'Search error';
                  finish('error event');
                  break;
              }
            } catch (_) { /* malformed JSON in SSE — ignore */ }
          }
        }
      });

      res.on('end',   () => finish('stream end'));
      res.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    req.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// ─── Retry wrapper — handles 503 Server Busy with linear backoff ─────────────

async function sseSearchWithRetry(serverUrl, params, timeoutMs) {
  for (let attempt = 0; attempt < MAX_503_RETRIES; attempt++) {
    try {
      return await sseSearch(serverUrl, params, timeoutMs);
    } catch (err) {
      const is503 = err.message && err.message.includes('HTTP 503');
      if (!is503 || attempt >= MAX_503_RETRIES - 1) throw err;
      const waitMs = RETRY_BASE_MS * (attempt + 1);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

// ─── Extract a usable property ID from a records array ────────────────────────

function extractPropertyId(records) {
  for (const rec of records) {
    const id = rec.parcelId || rec.accountNumber;
    if (id && String(id).trim()) return String(id).trim();
  }
  // Try additionalDetails JSON
  for (const rec of records) {
    try {
      const ad = typeof rec.additionalDetails === 'string'
        ? JSON.parse(rec.additionalDetails)
        : rec.additionalDetails;
      const id = ad?.['Property ID'] || ad?.['Account'] || ad?.['Parcel ID'];
      if (id) return String(id).trim();
    } catch (_) {}
  }
  return null;
}

// ─── Main test function ────────────────────────────────────────────────────────

async function testCounty(serverUrl, state, county, countyData, options = {}) {
  const verbose = options.verbose ?? false;

  const result = {
    county,
    state,
    platform: countyData?.platform || 'unknown',
    url: countyData?.url || null,
    nameSearch: null,
    nameUsed: null,
    propertyId: null,
    idSearch: null,
    status: 'pending',
    score: 0,
    errors: [],
    warnings: [],
    testedAt: new Date().toISOString(),
    durationMs: 0,
  };

  const t0 = Date.now();

  // ── No URL ─────────────────────────────────────────────────────────────────
  if (!result.url) {
    result.status = 'no_url';
    result.durationMs = Date.now() - t0;
    return result;
  }

  try {
    // ── Step 1: Name search (try fallback names until we get results) ─────────
    let nameResult = null;
    for (const lastName of FALLBACK_NAMES) {
      if (verbose) console.log(`  [${county}] Searching lastName="${lastName}"...`);
      nameResult = await sseSearchWithRetry(
        serverUrl,
        { state, county, lastName },
        NAME_TIMEOUT_MS
      );

      if (nameResult.captchaBlocked) break;
      if (nameResult.error)          break;
      if (nameResult.records?.length > 0) {
        result.nameUsed = lastName;
        break;
      }
    }

    result.nameSearch = {
      totalFound:  nameResult.totalFound,
      recordCount: nameResult.records?.length ?? 0,
      summary:     nameResult.summary,
      captcha:     nameResult.captchaBlocked,
      captchaType: nameResult.captchaType,
      error:       nameResult.error,
      searchedUrl: nameResult.searchedUrl,
    };

    // ── CAPTCHA ────────────────────────────────────────────────────────────────
    if (nameResult.captchaBlocked) {
      result.status     = 'captcha';
      result.score      = 0;
      result.durationMs = Date.now() - t0;
      return result;
    }

    // ── Error ─────────────────────────────────────────────────────────────────
    if (nameResult.error) {
      result.status     = 'error';
      result.errors.push(`Name search error: ${nameResult.error}`);
      result.durationMs = Date.now() - t0;
      return result;
    }

    // ── No results from name search ───────────────────────────────────────────
    if (!nameResult.records?.length) {
      result.status     = 'no_results';
      result.score      = 10; // URL alive, just no Smith/Johnson results
      result.durationMs = Date.now() - t0;
      return result;
    }

    // ── Step 2: Extract property ID ───────────────────────────────────────────
    const propertyId = extractPropertyId(nameResult.records);
    result.propertyId = propertyId;

    if (!propertyId) {
      result.status     = 'no_property_id';
      result.score      = 30;
      result.warnings.push('Name search returned records but no parcelId/accountNumber found');
      result.durationMs = Date.now() - t0;
      return result;
    }

    if (verbose) console.log(`  [${county}] Found parcelId="${propertyId}", running ID search...`);

    // ── Step 3: Property ID search ────────────────────────────────────────────
    const idResult = await sseSearchWithRetry(
      serverUrl,
      { state, county, accountNumber: propertyId },
      ID_TIMEOUT_MS
    );

    result.idSearch = {
      totalFound:  idResult.totalFound,
      recordCount: idResult.records?.length ?? 0,
      summary:     idResult.summary,
      captcha:     idResult.captchaBlocked,
      captchaType: idResult.captchaType,
      error:       idResult.error,
      searchedUrl: idResult.searchedUrl,
      sampleRecord: idResult.records?.[0] ?? null,
      // Keep first 3 records so validator can do full field checks
      records:     idResult.records?.slice(0, 3) ?? [],
    };

    if (idResult.captchaBlocked) {
      result.status     = 'captcha';
      result.score      = 20;
      result.durationMs = Date.now() - t0;
      return result;
    }

    if (idResult.error) {
      result.status     = 'error';
      result.errors.push(`ID search error: ${idResult.error}`);
      result.score      = 20;
      result.durationMs = Date.now() - t0;
      return result;
    }

    // ── Step 4: Score ─────────────────────────────────────────────────────────
    result.score  = scoreResult(idResult);
    result.status = result.score >= 80 ? 'pass'
                  : result.score >= 45 ? 'partial'
                  : 'fail';

  } catch (err) {
    result.status = 'error';
    result.errors.push(err.message);
  }

  result.durationMs = Date.now() - t0;
  return result;
}

// ─── Quality scoring ──────────────────────────────────────────────────────────

function scoreResult(idResult) {
  if (!idResult || !idResult.records?.length) return 0;

  const rec = idResult.records[0];
  let score = 0;

  // Presence checks
  const check = (val, pts) => {
    if (val && String(val).trim() && String(val).trim() !== 'N/A') score += pts;
  };

  check(idResult.totalFound > 0, 15);     // found something
  check(rec.parcelId,             10);     // parcel ID
  check(rec.ownerName,            10);     // owner name
  check(rec.propertyAddress,      10);     // address
  check(rec.taxAmountDue,         10);     // tax amount
  check(rec.paymentStatus,         5);     // payment status
  check(rec.taxYear,               5);     // tax year

  // additionalDetails depth check
  try {
    const ad = typeof rec.additionalDetails === 'string'
      ? JSON.parse(rec.additionalDetails)
      : (rec.additionalDetails || {});

    const hasLegal = ad['Legal Description'] || ad['legalDescription'];
    const hasLand  = ad['Land Value'] || ad['land_value'];
    const hasImprv = ad['Improvement Value'] || ad['improvement_value'];
    const hasBills = Array.isArray(ad['Bill Tables']) && ad['Bill Tables'].length > 0;
    const hasAcres = ad['Effective Acres'] || ad['Acres'] || ad['acres'];

    check(hasLegal, 10);
    check(hasLand,   5);
    check(hasImprv,  5);
    check(hasBills, 10);
    check(hasAcres,  5);
  } catch (_) {
    // no additionalDetails — don't penalise, just don't award bonus points
  }

  return Math.min(score, 100);
}

module.exports = { testCounty, sseSearch, extractPropertyId, scoreResult };
