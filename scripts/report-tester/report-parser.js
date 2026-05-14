'use strict';

/**
 * report-parser.js
 *
 * Reads county test results from the automation checkpoint (or a raw JSON
 * results file) and normalises them into a flat structure that field-checker
 * can work against.
 *
 * Input sources supported:
 *   1. Automation checkpoint   (scripts/tx-county-automation/reports/checkpoint-TX.json)
 *   2. Automation results JSON (scripts/tx-county-automation/reports/tx-TX-*.json)
 *   3. Single county object    (passed directly for live / unit testing)
 */

const fs   = require('fs');
const path = require('path');

// ─── Parse additionalDetails safely ──────────────────────────────────────────
function parseAD(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

// ─── Normalise one raw county result from the checkpoint ──────────────────────
function normaliseCountyResult(countyName, raw) {
  const idSearch   = raw.idSearch   || {};
  const nameSearch = raw.nameSearch || {};

  // Pull the first record from either the records array or sampleRecord
  const records = Array.isArray(idSearch.records) && idSearch.records.length
    ? idSearch.records
    : (idSearch.sampleRecord ? [idSearch.sampleRecord] : []);

  const record = records[0] || {};
  const ad     = parseAD(record.additionalDetails);

  return {
    // Identity
    county:      countyName,
    state:       raw.state || 'TX',
    platform:    raw.platform || 'unknown',
    url:         raw.url || null,

    // Top-level automation result
    autoStatus:  raw.status,
    autoScore:   raw.score ?? 0,
    testedAt:    raw.testedAt,
    durationMs:  raw.durationMs,
    errors:      raw.errors || [],
    warnings:    raw.warnings || [],

    // Name search summary
    nameSearch: {
      recordCount: nameSearch.recordCount ?? 0,
      nameUsed:    raw.nameUsed || null,
      searchedUrl: nameSearch.searchedUrl || null,
    },

    // Property ID used for detail search
    propertyId: raw.propertyId || null,

    // ID search summary
    idSearch: {
      recordCount: idSearch.recordCount ?? 0,
      summary:     idSearch.summary || null,
      searchedUrl: idSearch.searchedUrl || null,
      captcha:     idSearch.captcha || false,
    },

    // Flat record fields (top-level)
    record: {
      parcelId:        record.parcelId        || null,
      ownerName:       record.ownerName       || null,
      propertyAddress: record.propertyAddress || null,
      legalDescription:record.legalDescription|| null,
      taxAmountDue:    record.taxAmountDue    || null,
      paymentStatus:   record.paymentStatus   || null,
      taxYear:         record.taxYear         || null,
      county:          record.county          || countyName,
      state:           record.state           || raw.state || 'TX',
    },

    // Raw additionalDetails (parsed)
    ad,

    // Source diagnostics
    hasIdRecord: records.length > 0,
  };
}

// ─── Load from checkpoint file ─────────────────────────────────────────────────
function loadCheckpoint(stateCode = 'TX', checkpointDir = null) {
  const dir  = checkpointDir || path.resolve(__dirname, '../tx-county-automation/reports');
  const file = path.join(dir, `checkpoint-${stateCode}.json`);

  if (!fs.existsSync(file)) {
    throw new Error(`Checkpoint not found: ${file}\nRun the automation first: node scripts/tx-county-automation`);
  }

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.entries(raw)
    .filter(([k]) => k !== '_done')
    .map(([county, result]) => normaliseCountyResult(county, result));
}

// ─── Load from a full results JSON (output of report-generator) ───────────────
function loadResultsJson(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const results = raw.results || raw;
  if (!Array.isArray(results)) throw new Error('Expected results array in JSON file');
  return results.map(r => normaliseCountyResult(r.county, r));
}

// ─── Load a single county result (for testing one county) ─────────────────────
function loadSingleCounty(county, stateCode = 'TX', checkpointDir = null) {
  const all = loadCheckpoint(stateCode, checkpointDir);
  const found = all.find(r => r.county.toLowerCase() === county.toLowerCase());
  if (!found) throw new Error(`County "${county}" not found in checkpoint for ${stateCode}`);
  return [found];
}

// ─── Auto-detect which counties are from CAD only vs tax office ────────────────
function detectDataSource(parsed) {
  const ad = parsed.ad || {};
  const keys = Object.keys(ad).map(k => k.toLowerCase());

  const hasTaxBills  = !!(ad['Bill Tables'] || ad.billTables || ad.taxHistory);
  const hasTaxAmts   = !!(ad['Total Taxes Due'] || ad['Current Due'] || ad.currentDue);
  const hasTaxUnits  = !!(ad.taxingUnits || ad.collectingEntities);
  const hasAssessment= !!(ad.landMarketValue || ad['Land Value'] || ad.landValue ||
                          ad.appraisedValue  || ad.marketValue);
  const hasTaxStatus = !!parsed.record.paymentStatus;
  const isPaymentSrc = keys.some(k => ['bill', 'payment', 'tax due', 'amount due', 'delinquent'].some(t => k.includes(t)));

  const taxOfficePresent = hasTaxBills || hasTaxAmts || hasTaxUnits || hasTaxStatus || isPaymentSrc;
  const cadPresent       = hasAssessment || !!(parsed.record.legalDescription || ad.legalDescription);

  return {
    cadPresent,
    taxOfficePresent,
    hasTaxBills,
    hasTaxAmts,
    hasTaxUnits,
    hasAssessment,
    hasTaxStatus,
    cadOnly: cadPresent && !taxOfficePresent,
    taxOnly: taxOfficePresent && !cadPresent,
    both:    cadPresent && taxOfficePresent,
    neither: !cadPresent && !taxOfficePresent,
  };
}

module.exports = { loadCheckpoint, loadResultsJson, loadSingleCounty, normaliseCountyResult, detectDataSource, parseAD };
